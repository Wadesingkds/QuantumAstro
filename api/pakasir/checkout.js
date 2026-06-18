// Pakasir Checkout API
// POST /api/pakasir/checkout
// Requires Authorization: Bearer *** header (Supabase JWT)
// Body: { plan: 'lifetime' }
// amount is ALWAYS determined server-side — never trust client

const PLAN_PRICES = {
  lifetime: 500000
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const PAKASIR_SLUG = process.env.PAKASIR_SLUG;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

  if (!PAKASIR_SLUG) {
    return res.status(500).json({ error: 'Pakasir slug not configured' });
  }

  // Require authenticated user
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'Login required to subscribe' });
  }

  // Verify JWT and get user info
  let userId, userEmail;
  try {
    const userResp = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${token}`
      }
    });

    if (!userResp.ok) {
      return res.status(401).json({ error: 'Invalid session. Please login again.' });
    }

    const userData = await userResp.json();
    userId = userData.id;
    userEmail = userData.email;

    if (!userId) {
      return res.status(401).json({ error: 'Invalid user session' });
    }
  } catch (e) {
    return res.status(401).json({ error: 'Auth verification failed' });
  }

  const { plan } = req.body;

  // Validate plan
  if (!plan || !PLAN_PRICES[plan]) {
    return res.status(400).json({ error: 'Invalid plan. Only lifetime is available.' });
  }

  // Use server-determined price
  const amount = PLAN_PRICES[plan];
  const orderId = `QL-${Date.now()}-${plan.toUpperCase()}`;

  // Insert pending subscription to Supabase, linked to user_id
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/subscriptions`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'resolution=merge-duplicates'
        },
        body: JSON.stringify({
          user_id: userId,
          email: userEmail,
          plan,
          status: 'pending',
          expires_at: null, // lifetime = no expiry
          metadata: { order_id: orderId, amount, timestamp: Date.now() }
        })
      });
    } catch (e) {
      console.error('Supabase insert error:', e.message);
    }
  }

  // Redirect to server-side activation endpoint after payment
  const activationUrl = `https://quantum-leaps-gamma.vercel.app/api/subscription/activate`;
  const redirectUrl = `${activationUrl}?order_id=${encodeURIComponent(orderId)}&user_id=${encodeURIComponent(userId)}&plan=${encodeURIComponent(plan)}`;
  const checkoutUrl = `https://app.pakasir.com/pay/${PAKASIR_SLUG}/${amount}?order_id=${encodeURIComponent(orderId)}&redirect=${encodeURIComponent(redirectUrl)}`;

  return res.status(200).json({ checkoutUrl });
}
