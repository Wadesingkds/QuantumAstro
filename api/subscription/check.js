// Server-side subscription status check
// GET /api/subscription/check
// Requires Authorization: Bearer <supabase_jwt> header
// Source of truth: profiles.is_pro (+ pro_activated_at)

export default async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Supabase not configured' });
  }

  // Require authenticated user
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    // Verify JWT and get user id
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`
      }
    });

    if (!userResp.ok) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    const userData = await userResp.json();
    const userId = userData.id;

    if (!userId) {
      return res.status(401).json({ error: 'Invalid user session' });
    }

    // Source of truth: profiles.is_pro
    const profResp = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=is_pro,pro_activated_at,pro_order_id`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      }
    );
    const profRows = await profResp.json();
    const prof = Array.isArray(profRows) ? profRows[0] : null;

    if (prof && prof.is_pro === true) {
      return res.status(200).json({
        active: true,
        status: 'active',
        plan: 'lifetime',
        activated_at: prof.pro_activated_at || null,
        order_id: prof.pro_order_id || null
      });
    }

    return res.status(200).json({ active: false, status: 'none' });

  } catch (e) {
    console.error('[Subscription Check] Error:', e.message);
    return res.status(500).json({ error: 'Check failed' });
  }
}
