// Admin - Cek member subscriptions
// GET /api/admin/members?key=CRON_SECRET
export default async function handler(req, res) {
  // Simple auth via CRON_SECRET
  if (req.query.key !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  try {
    // Query subscriptions with joined user data
    const subResp = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?select=email,user_id,plan,status,created_at,expires_at,metadata&order=created_at.desc`,
      {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`
        }
      }
    );

    const subscriptions = await subResp.json();

    // Count stats
    const total = subscriptions.length;
    const active = subscriptions.filter(s => s.status === 'active').length;
    const pending = subscriptions.filter(s => s.status === 'pending').length;
    const expired = subscriptions.filter(s => s.status === 'expired' || s.status === 'cancelled').length;

    return res.status(200).json({
      stats: { total, active, pending, expired },
      members: subscriptions.map(s => ({
        email: s.email,
        status: s.status,
        plan: s.plan,
        created: s.created_at,
        expires: s.expires_at,
        metadata: s.metadata
      }))
    });
  } catch (err) {
    console.error('Admin members error:', err);
    return res.status(500).json({ error: err.message });
  }
}
