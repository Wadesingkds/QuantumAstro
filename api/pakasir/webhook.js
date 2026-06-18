// Pakasir Webhook Handler
// POST /api/pakasir/webhook
// Cross-verifies payment via Pakasir Transaction Detail API before activating

const PLAN_PRICES = {
  lifetime: 500000
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const PAKASIR_SLUG = process.env.PAKASIR_SLUG;
  const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  const payload = req.body?.payment || req.body;
  const { order_id, status, amount } = payload;

  console.log('[Pakasir Webhook] payload:', JSON.stringify(req.body));

  if (!order_id) {
    return res.status(400).json({ error: 'Missing order_id' });
  }

  const isPaid = status === 'paid' || status === 'success' || status === 'completed';
  if (!isPaid) {
    return res.status(200).json({ received: true, note: 'status_not_paid' });
  }

  // ── Cross-verify with Pakasir Transaction Detail API ──
  const SKIP_VERIFY = process.env.SKIP_PAKASIR_VERIFY === 'true';
  if (!SKIP_VERIFY && PAKASIR_API_KEY && PAKASIR_SLUG) {
    try {
      const verifyUrl = `https://app.pakasir.com/api/transactiondetail?project=${encodeURIComponent(PAKASIR_SLUG)}&amount=${encodeURIComponent(amount)}&order_id=${encodeURIComponent(order_id)}&api_key=${encodeURIComponent(PAKASIR_API_KEY)}`;
      const verifyResp = await fetch(verifyUrl);
      const verifyData = await verifyResp.json();
      const txn = verifyData?.transaction;

      if (!txn) {
        console.error('[Pakasir Webhook] Transaction not found in Pakasir:', order_id);
        return res.status(400).json({ error: 'Transaction not found in Pakasir' });
      }

      const txnStatus = txn.status;
      if (txnStatus !== 'completed' && txnStatus !== 'paid' && txnStatus !== 'success') {
        console.error(`[Pakasir Webhook] Pakasir status '${txnStatus}' not paid — rejected`);
        return res.status(400).json({ error: `Payment not confirmed by Pakasir (status: ${txnStatus})` });
      }

      if (Number(txn.amount) < 500000) {
        console.error(`[Pakasir Webhook] Amount too low: ${txn.amount}`);
        return res.status(400).json({ error: 'Amount too low' });
      }

      console.log('[Pakasir Webhook] Pakasir verification OK:', order_id, txn.amount);
    } catch (e) {
      console.error('[Pakasir Webhook] Pakasir verification error:', e.message);
      return res.status(500).json({ error: 'Cannot verify payment with Pakasir' });
    }
  } else {
    console.warn('[Pakasir Webhook] PAKASIR_API_KEY not set — skipping cross-verification');
  }

  // ── Activate in Supabase by user_id (from order metadata) ──
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      // Fetch subscription by order_id
      const checkResp = await fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?metadata->>order_id=eq.${encodeURIComponent(order_id)}&select=user_id,plan,metadata,status`,
        {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
          }
        }
      );
      const rows = await checkResp.json();

      if (!rows || rows.length === 0) {
        console.error('[Pakasir Webhook] Order not found in Supabase:', order_id);
        return res.status(404).json({ error: 'Order not found' });
      }

      const sub = rows[0];

      // Idempotency guard
      if (sub.status === 'active') {
        console.log('[Pakasir Webhook] Already active:', order_id);
        return res.status(200).json({ received: true, note: 'already_active' });
      }

      // Activate by user_id
      const patchResp = await fetch(
        `${SUPABASE_URL}/rest/v1/subscriptions?metadata->>order_id=eq.${encodeURIComponent(order_id)}`,
        {
          method: 'PATCH',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
          },
          body: JSON.stringify({
            status: 'active',
            updated_at: new Date().toISOString(),
            metadata: {
              ...sub.metadata,
              order_id,
              paid_at: new Date().toISOString(),
              amount
            }
          })
        }
      );
      const data = await patchResp.json();
      console.log('[Pakasir Webhook] Activated for user_id:', sub.user_id, JSON.stringify(data));

      // ── Append income row to Google Sheet via Apps Script Web App ──
      const SHEETS_URL = process.env.SHEETS_WEBHOOK_URL;
      if (SHEETS_URL) {
        try {
          const method = payload.payment_method || 'qris';
          const adm = computeAdmFee(Number(amount), method);
          const tarik = Number(amount) - adm;
          const didik = Math.round(tarik * 0.4);
          const muhib = Math.round(tarik * 0.4);
          const quantum = tarik - didik - muhib; // remainder to Quantum (rounding safety)
          const dateStr = (payload.completed_at
            ? new Date(payload.completed_at)
            : new Date()
          ).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

          const sheetResp = await fetch(SHEETS_URL, {
            method: 'POST',
            body: JSON.stringify({
              date: dateStr,
              order_id,
              pakasir: Number(amount),
              adm,
              tarik,
              didik,
              muhib,
              quantum
            })
            // No Content-Type header — Apps Script CORS rejects preflight
          });
          const sheetResult = await sheetResp.json().catch(() => ({}));
          console.log('[Pakasir Webhook] Sheet append:', sheetResult.status || sheetResp.status);
        } catch (e) {
          console.error('[Pakasir Webhook] Sheet append error (non-fatal):', e.message);
        }
      } else {
        console.warn('[Pakasir Webhook] SHEETS_WEBHOOK_URL not set — skipping sheet append');
      }
    } catch (e) {
      console.error('[Pakasir Webhook] Supabase error:', e.message);
      return res.status(500).json({ error: 'Internal error' });
    }
  }

  return res.status(200).json({ received: true });
}

// ── Pakasir admin fee (per payment_method) ──
function computeAdmFee(amount, method) {
  if (method === 'qris') {
    // QRIS > 105K: 1% of amount
    if (amount > 105000) return Math.ceil(amount * 0.01);
    return Math.ceil(amount * 0.007); // < 105K: 0.7%
  }
  // VA methods (bni_va, bri_va, cimb_va, etc): flat 2500
  if (method && method.endsWith('_va')) return 2500;
  // Fallback: 1%
  return Math.ceil(amount * 0.01);
}
