// Cron Job: Expire Subscriptions
// Updates subscription status to 'expired' when expires_at < now
// Triggered daily via Vercel Cron

export default async function handler(req, res) {
  // Verify cron secret to prevent unauthorized access
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ 
      error: 'Supabase credentials not configured',
      updated: 0
    });
  }

  try {
    const now = new Date().toISOString();
    
    // Update all active subscriptions that have passed expires_at
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/subscriptions?status=eq.active&expires_at=lt.${now}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          status: 'expired',
          updated_at: now
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Supabase error: ${response.status} ${errorText}`);
    }

    const updated = await response.json();
    const count = Array.isArray(updated) ? updated.length : 0;

    console.log(`[CRON] Expired ${count} subscriptions at ${now}`);

    return res.status(200).json({
      success: true,
      updated: count,
      timestamp: now
    });

  } catch (err) {
    console.error('[CRON] Expire subscriptions error:', err);
    return res.status(500).json({ 
      error: err.message,
      updated: 0
    });
  }
}
