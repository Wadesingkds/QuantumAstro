// Cron Job: Expire Subscriptions
// NOTE: lifetime-only product — no expiry. Kept as no-op so Vercel Cron
// schedule (if any) stays green.
export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return res.status(200).json({ updated: 0, note: 'lifetime only — no expiry' });
}
