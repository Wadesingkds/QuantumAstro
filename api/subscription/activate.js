// Server-side activation endpoint
// GET /api/subscription/activate?order_id=...&user_id=...&plan=...
// Called by Pakasir redirect after payment
// Verifies order exists in Supabase before showing success page

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { order_id, user_id, plan } = req.query;

  if (!order_id || !user_id || !plan) {
    return res.redirect('/success.html?status=error&reason=missing_params');
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.redirect('/success.html?status=pending');
  }

  try {
    // Check order exists and belongs to this user
    const checkResp = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?metadata->>order_id=eq.${encodeURIComponent(order_id)}&user_id=eq.${encodeURIComponent(user_id)}&select=status,plan`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      }
    );
    const rows = await checkResp.json();

    if (!rows || rows.length === 0) {
      // Order not found — may still be pending webhook
      return res.redirect('/success.html?status=pending&reason=verifying');
    }

    const sub = rows[0];

    if (sub.status === 'active') {
      return res.redirect(`/success.html?status=active&plan=${encodeURIComponent(sub.plan)}&verified=1`);
    }

    // Pending — webhook will activate when Pakasir confirms
    return res.redirect(`/success.html?status=pending&plan=${encodeURIComponent(plan)}`);

  } catch (e) {
    console.error('[Activate] Error:', e.message);
    return res.redirect('/success.html?status=pending');
  }
}
