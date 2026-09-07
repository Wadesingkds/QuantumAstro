// SumoPod Webhook Handler
// POST /api/webhook/sumopod  (URL persis seperti yang didaftarkan di dashboard SumoPod)
// Verifikasi: Svix HMAC (diutamakan) atau static token. Raw body WAJIB untuk HMAC.
// Setelah valid: update payments + set profiles.is_pro=true + catat ke Google Sheet.

import { verifySvixSignature, verifyWebhookToken, parseSumopodEvent, PRO_AMOUNT } from "../../lib/sumopod.js";

export const config = {
  api: { bodyParser: false },
};

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// Simple in-memory rate limit (per process).
const hits = new Map();
function rateLimited(key) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(key, arr);
  return arr.length > 30; // max 30/min per IP
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  try {
    const ip =
      req.headers["x-real-ip"] ||
      (req.headers["x-forwarded-for"] || "").split(",")[0] ||
      "unknown";
    if (rateLimited(ip)) {
      return res.status(429).json({ error: "rate limited" });
    }

    const rawBody = await readRawBody(req);
    let body;
    try {
      body = JSON.parse(rawBody || "{}");
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    // ── Verify origin: Svix signature dulu, fallback ke static token ──
    const svixOk = verifySvixSignature(rawBody, req.headers);
    const tokenOk = !svixOk && verifyWebhookToken(req.headers);
    if (!svixOk && !tokenOk) {
      console.error("[SumoPod Webhook] signature/token invalid");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const evt = parseSumopodEvent(body);
    console.log("[SumoPod Webhook] event:", evt.type, evt.orderId, evt.status);

    if (!evt.orderId) {
      return res.status(400).json({ error: "Missing order_id" });
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const sb = (path, opts = {}) =>
      fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...opts,
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          ...(opts.headers || {}),
        },
      });

    if (!evt.isPaid) {
      // Non-paid (failed/expired/cancelled): catat status saja
      try {
        await sb(`payments?order_id=eq.${encodeURIComponent(evt.orderId)}`, {
          method: "PATCH",
          body: JSON.stringify({ status: evt.status || evt.type || "failed" }),
        });
      } catch (e) {
        console.error("[SumoPod Webhook] status update error:", e.message);
      }
      return res.status(200).json({ received: true, note: "status_not_paid" });
    }

    // ── Paid: cocokkan order di tabel payments ──
    const checkResp = await sb(
      `payments?order_id=eq.${encodeURIComponent(evt.orderId)}&select=user_id,amount,status,fee`
    );
    const rows = await checkResp.json();

    if (!checkResp.ok || !Array.isArray(rows) || rows.length === 0) {
      console.error("[SumoPod Webhook] Order not found in Supabase:", evt.orderId, "status:", checkResp.status);
      return res.status(404).json({ error: "Order not found" });
    }

    const pay = rows[0];

    // Idempotency guard
    if (pay.status === "completed") {
      console.log("[SumoPod Webhook] Already completed:", evt.orderId);
      return res.status(200).json({ received: true, note: "already_active" });
    }

    // Sanity: nominal minimal sesuai harga plan
    const paidAmount = Number(evt.amount ?? pay.amount ?? 0);
    if (paidAmount > 0 && paidAmount < PRO_AMOUNT) {
      console.error(`[SumoPod Webhook] Amount too low: ${paidAmount}`);
      return res.status(400).json({ error: "Amount too low" });
    }

    const completedAt = evt.paidAt || new Date().toISOString();
    const fee = evt.fee ?? pay.fee ?? null;

    await sb(`payments?order_id=eq.${encodeURIComponent(evt.orderId)}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "completed",
        completed_at: completedAt,
        fee,
        payment_method: evt.paymentMethod || "qris",
      }),
    });

    // ── Aktivasi PRO ──
    if (pay.user_id) {
      await sb(`profiles?id=eq.${encodeURIComponent(pay.user_id)}`, {
        method: "PATCH",
        body: JSON.stringify({
          is_pro: true,
          pro_activated_at: completedAt,
          pro_order_id: evt.orderId,
          updated_at: completedAt,
        }),
      });
      console.log("[SumoPod Webhook] PRO activated for user_id:", pay.user_id);
    } else {
      console.error("[SumoPod Webhook] payment has no user_id:", evt.orderId);
    }

    // ── Append income row ke Google Sheet via Apps Script Web App ──
    const SHEETS_URL = process.env.SHEETS_WEBHOOK_URL;
    if (SHEETS_URL) {
      try {
        const amount = paidAmount || PRO_AMOUNT;
        const method = evt.paymentMethod || "qris";
        // Fee aktual dari SumoPod; fallback estimasi 0.7% QRIS
        const adm = Number(fee ?? Math.ceil(amount * 0.007));
        const tarik = amount - adm;
        const didik = Math.round(tarik * 0.4);
        const muhib = Math.round(tarik * 0.4);
        const quantum = tarik - didik - muhib; // remainder ke Quantum (rounding safety)
        const dateStr = new Date(completedAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });

        const sheetResp = await fetch(SHEETS_URL, {
          method: "POST",
          body: JSON.stringify({
            date: dateStr,
            order_id: evt.orderId,
            sumopod: amount,
            adm,
            tarik,
            didik,
            muhib,
            quantum,
          }),
          // No Content-Type header — Apps Script CORS rejects preflight
        });
        const sheetResult = await sheetResp.json().catch(() => ({}));
        console.log("[SumoPod Webhook] Sheet append:", sheetResult.status || sheetResp.status);
      } catch (e) {
        console.error("[SumoPod Webhook] Sheet append error (non-fatal):", e.message);
      }
    } else {
      console.warn("[SumoPod Webhook] SHEETS_WEBHOOK_URL not set — skipping sheet append");
    }

    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("[SumoPod Webhook]", err);
    return res.status(500).json({ error: (err && err.message) || "Internal error" });
  }
}
