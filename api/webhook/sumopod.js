// SumoPod Webhook Handler
// POST /api/webhook/sumopod  (URL persis seperti yang didaftarkan di dashboard SumoPod)
// Verifikasi: Svix HMAC (diutamakan) atau static token. Raw body WAJIB untuk HMAC.
// Setelah valid: aktivasi subscription di Supabase + catat ke Google Sheet.

import { verifySvixSignature, verifyWebhookToken, parseSumopodEvent, PRO_AMOUNT } from "../../../lib/sumopod.js";

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

    if (!evt.isPaid) {
      // Non-paid (failed/expired/cancelled): catat status saja
      if (SUPABASE_URL && SUPABASE_KEY) {
        try {
          await fetch(
            `${SUPABASE_URL}/rest/v1/subscriptions?metadata->>order_id=eq.${encodeURIComponent(evt.orderId)}`,
            {
              method: "PATCH",
              headers: {
                apikey: SUPABASE_KEY,
                Authorization: `Bearer ${SUPABASE_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ status: evt.status || evt.type || "failed", updated_at: new Date().toISOString() }),
            }
          );
        } catch (e) {
          console.error("[SumoPod Webhook] status update error:", e.message);
        }
      }
      return res.status(200).json({ received: true, note: "status_not_paid" });
    }

    // ── Paid: cocokkan order di Supabase ──
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ error: "Supabase not configured" });
    }

    const checkResp = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?metadata->>order_id=eq.${encodeURIComponent(evt.orderId)}&select=user_id,plan,metadata,status`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    const rows = await checkResp.json();

    if (!rows || rows.length === 0) {
      console.error("[SumoPod Webhook] Order not found in Supabase:", evt.orderId);
      return res.status(404).json({ error: "Order not found" });
    }

    const sub = rows[0];

    // Idempotency guard
    if (sub.status === "active") {
      console.log("[SumoPod Webhook] Already active:", evt.orderId);
      return res.status(200).json({ received: true, note: "already_active" });
    }

    // Sanity: nominal minimal sesuai harga plan
    const paidAmount = Number(evt.amount ?? sub.metadata?.amount ?? 0);
    if (paidAmount > 0 && paidAmount < PRO_AMOUNT) {
      console.error(`[SumoPod Webhook] Amount too low: ${paidAmount}`);
      return res.status(400).json({ error: "Amount too low" });
    }

    const completedAt = evt.paidAt || new Date().toISOString();

    const patchResp = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?metadata->>order_id=eq.${encodeURIComponent(evt.orderId)}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          status: "active",
          updated_at: completedAt,
          metadata: {
            ...sub.metadata,
            provider: "sumopod",
            order_id: evt.orderId,
            paid_at: completedAt,
            amount: paidAmount || sub.metadata?.amount,
            sumopod_payment_id: evt.paymentId || sub.metadata?.sumopod_payment_id || null,
            sumopod_fee: evt.fee ?? sub.metadata?.sumopod_fee ?? null,
            payment_method: evt.paymentMethod || "qris",
          },
        }),
      }
    );
    const data = await patchResp.json();
    console.log("[SumoPod Webhook] Activated for user_id:", sub.user_id, JSON.stringify(data).slice(0, 200));

    // ── Append income row ke Google Sheet via Apps Script Web App ──
    const SHEETS_URL = process.env.SHEETS_WEBHOOK_URL;
    if (SHEETS_URL) {
      try {
        const amount = paidAmount || Number(sub.metadata?.amount) || PRO_AMOUNT;
        const method = evt.paymentMethod || "qris";
        // Fee aktual dari SumoPod; fallback estimasi 0.7% QRIS
        const adm = Number(evt.fee ?? sub.metadata?.sumopod_fee ?? Math.ceil(amount * 0.007));
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
