// SumoPod payment gateway helper (plain Node, no deps).
// API: POST {BASE}/payments with `X-Api-Key` header.
// Webhook: Svix-style HMAC (svix-* headers + whsec_ secret) OR static token
// (x-webhook-token header + whtok_ token). Both supported; signature preferred.

import crypto from "node:crypto";

const BASE_URL = (process.env.SUMOPOD_BASE_URL || "https://api-pay.sumopod.com/api/v1").replace(/\/+$/, "");
export const SUMOPOD_API_KEY = process.env.SUMOPOD_API_KEY || "";
export const SUMOPOD_WEBHOOK_SECRET = process.env.SUMOPOD_WEBHOOK_SECRET || "";
export const SUMOPOD_WEBHOOK_TOKEN = process.env.SUMOPOD_WEBHOOK_TOKEN || "";

export const PRO_AMOUNT = 1000000; // Rp 1.000.000 — harga premium sekali bayar (lifetime access)

export async function createPayment({ orderId, amount, successReturnUrl, cancelReturnUrl, method = "QRIS", expiresInHours = 24 }) {
  if (!SUMOPOD_API_KEY) throw new Error("SUMOPOD_API_KEY not configured");
  const res = await fetch(`${BASE_URL}/payments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": SUMOPOD_API_KEY },
    body: JSON.stringify({
      order_id: orderId,
      amount,
      currency: "IDR",
      payment_method_type_code: method,
      expires_in_hours: expiresInHours,
      success_return_url: successReturnUrl,
      cancel_return_url: cancelReturnUrl,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.payment_link_url) {
    throw new Error("SumoPod create payment failed: " + JSON.stringify(data).slice(0, 300));
  }
  return data; // { payment_id, order_id, amount, fee, net_amount, payment_link_url, status, expires_at }
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Svix verification: signedContent = `${svix-id}.${svix-timestamp}.${rawBody}`,
// key = base64(whsec_ secret tanpa prefix), signature = base64(HMAC-SHA256).
export function verifySvixSignature(rawBody, headers) {
  const svixId = headers["svix-id"];
  const svixTimestamp = headers["svix-timestamp"];
  const svixSig = headers["svix-signature"];
  if (!svixId || !svixTimestamp || !svixSig || !SUMOPOD_WEBHOOK_SECRET) return false;

  const ts = parseInt(svixTimestamp, 10);
  if (Number.isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > 300) return false; // 5 menit tolerance anti-replay

  const secretB64 = SUMOPOD_WEBHOOK_SECRET.startsWith("whsec_")
    ? SUMOPOD_WEBHOOK_SECRET.slice(6)
    : SUMOPOD_WEBHOOK_SECRET;
  const key = Buffer.from(secretB64, "base64");
  const expected = crypto.createHmac("sha256", key).update(`${svixId}.${svixTimestamp}.${rawBody}`, "utf8").digest("base64");

  for (const entry of String(svixSig).split(" ")) {
    const parts = entry.split(",");
    if (parts.length < 2 || parts[0] !== "v1") continue;
    if (constantTimeEqual(expected, parts.slice(1).join(","))) return true;
  }
  return false;
}

export function verifyWebhookToken(headers) {
  const got = headers["x-webhook-token"] || headers["x-webhook_token"];
  if (!got || !SUMOPOD_WEBHOOK_TOKEN) return false;
  return constantTimeEqual(got, SUMOPOD_WEBHOOK_TOKEN);
}

// Normalisasi event SumoPod yang defensif — terima varian penamaan event & payload.
export function parseSumopodEvent(body) {
  const type = body.event_type || body.event || body.type || "";
  const d = body.data || body.payment || body;
  const orderId = d.order_id || d.orderId || d.merchant_order_id || body.order_id || null;
  const status = d.status || body.status || null;
  const amount = d.amount ?? d.total_payment ?? body.amount ?? null;
  const paymentId = d.payment_id || d.paymentId || d.id || null;
  const paymentMethod = d.payment_method || d.paymentMethod || d.payment_method_type || null;
  const paidAt = d.paid_at || d.completed_at || d.paidAt || null;
  const fee = d.fee ?? null;
  const t = String(type).toLowerCase();
  const paid = t === "payment.completed" || t === "payment.success" || t === "payment.paid" || t === "completed" || t === "success" || t === "paid" ||
    (status && ["completed", "success", "paid", "settlement"].includes(String(status).toLowerCase()));
  return { type: t, orderId, status, amount, paymentId, paymentMethod, paidAt, fee, isPaid: !!paid };
}
