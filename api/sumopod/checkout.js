// SumoPod Checkout API
// POST /api/sumopod/checkout
// Requires Authorization: Bearer *** header (Supabase JWT)
// Body: { plan: 'lifetime' }
// amount is ALWAYS determined server-side — never trust client

import { createPayment, PRO_AMOUNT } from "../../lib/sumopod.js";

const PLAN_PRICES = {
  lifetime: PRO_AMOUNT,
};

const SITE_URL = "https://quantumleaps.biz.id";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!process.env.SUMOPOD_API_KEY) {
    return res.status(500).json({ error: "SumoPod not configured" });
  }

  // Require authenticated user
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Login required to subscribe" });
  }

  // Verify JWT and get user info
  let userId, userEmail;
  try {
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
      },
    });

    if (!userResp.ok) {
      return res.status(401).json({ error: "Invalid session. Please login again." });
    }

    const userData = await userResp.json();
    userId = userData.id;
    userEmail = userData.email;

    if (!userId) {
      return res.status(401).json({ error: "Invalid user session" });
    }
  } catch (e) {
    return res.status(401).json({ error: "Auth verification failed" });
  }

  const { plan } = req.body || {};

  // Validate plan
  if (!plan || !PLAN_PRICES[plan]) {
    return res.status(400).json({ error: "Invalid plan. Only lifetime is available." });
  }

  // Use server-determined price
  const amount = PLAN_PRICES[plan];
  const orderId = `QL-${Date.now()}-${plan.toUpperCase()}`;

  // SumoPod redirects here after payment; our activate endpoint shows success page
  const successReturnUrl =
    `${SITE_URL}/api/subscription/activate` +
    `?order_id=${encodeURIComponent(orderId)}` +
    `&user_id=${encodeURIComponent(userId)}` +
    `&plan=${encodeURIComponent(plan)}`;
  const cancelReturnUrl = `${SITE_URL}/?payment=cancelled`;

  let payment;
  try {
    payment = await createPayment({
      orderId,
      amount,
      successReturnUrl,
      cancelReturnUrl,
      method: "QRIS",
      expiresInHours: 24,
    });
  } catch (e) {
    console.error("[SumoPod Checkout] create failed:", e.message);
    return res.status(502).json({ error: "Gagal membuat link pembayaran" });
  }

  // Insert pending payment row to Supabase, linked to user_id
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/payments`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          order_id: orderId,
          user_id: userId,
          amount,
          fee: payment.fee ?? null,
          payment_method: "qris",
          status: "pending",
        }),
      });
    } catch (e) {
      console.error("Supabase insert error:", e.message);
    }
  }

  return res.status(200).json({ checkoutUrl: payment.payment_link_url });
}
