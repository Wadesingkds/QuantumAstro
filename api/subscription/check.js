// Subscription Check API
// GET /api/subscription/check
// Requires Authorization: Bearer <supabase_jwt> header
// Returns: { premium: boolean, plan: string, expires_at: string }

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Server misconfigured', premium: false });
  }

  // Extract JWT from Authorization header
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Not authenticated', premium: false });
  }

  // Verify JWT and get user_id via Supabase Auth
  try {
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`
      }
    });

    if (!userResp.ok) {
      return res.status(401).json({ error: 'Invalid token', premium: false });
    }

    const userData = await userResp.json();
    const userId = userData.id;

    if (!userId) {
      return res.status(401).json({ error: 'Invalid user', premium: false });
    }

    // Query subscription by user_id (server-side with service key)
    const subResp = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${userId}&select=plan,status,expires_at`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      }
    );

    const data = await subResp.json();

    if (!data || data.length === 0) {
      return res.status(200).json({ premium: false });
    }

    const sub = data[0];
    const now = new Date();
    const expiresAt = sub.expires_at ? new Date(sub.expires_at) : null;
    const isPremium = sub.status === 'active' && (!expiresAt || expiresAt > now);

    return res.status(200).json({
      premium: isPremium,
      plan: sub.plan,
      status: sub.status,
      expires_at: sub.expires_at
    });

  } catch (err) {
    console.error('Subscription check error:', err);
    return res.status(500).json({ error: 'Failed to check subscription', premium: false });
  }
}
