// Server-side activation endpoint
// GET /api/subscription/activate?order_id=...&user_id=...&plan=...
// Called by SumoPod redirect after payment
// Verifies order is completed in payments table before showing success page

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
    // Check payment completed and belongs to this user
    const checkResp = await fetch(
      `${SUPABASE_URL}/rest/v1/payments?order_id=eq.${encodeURIComponent(order_id)}&user_id=eq.${encodeURIComponent(user_id)}&select=status`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      }
    );
    const rows = await checkResp.json();

    if (!checkResp.ok || !Array.isArray(rows) || rows.length === 0) {
      // Order not found — may still be pending webhook
      return res.redirect('/success.html?status=pending&reason=verifying');
    }

    if (rows[0].status === 'completed') {
      return res.redirect(`/success.html?status=active&plan=${encodeURIComponent(plan)}&verified=1`);
    }

    // Pending — webhook will activate when SumoPod confirms
    return res.redirect(`/success.html?status=pending&plan=${encodeURIComponent(plan)}`);

  } catch (e) {
    console.error('[Activate] Error:', e.message);
    return res.redirect('/success.html?status=pending');
  }
}
