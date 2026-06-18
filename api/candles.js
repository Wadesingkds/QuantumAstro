/**
 * /api/candles.js — Proxy fetch XAUUSD OHLC candles
 * Supports: Binance Futures (XAUUSDT), fallback to GoldAPI
 * Query: ?interval=15m&limit=200
 */

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { interval = '15m', limit = '200' } = req.query;

  // Validate interval
  const validIntervals = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d'];
  if (!validIntervals.includes(interval)) {
    return res.status(400).json({ error: 'Invalid interval' });
  }

  const lim = Math.min(parseInt(limit) || 200, 500);

  try {
    // Primary: Binance Futures XAUUSDT
    const binanceUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=${interval}&limit=${lim}`;
    const resp = await fetch(binanceUrl, { signal: AbortSignal.timeout(8000) });

    if (resp.ok) {
      const raw = await resp.json();
      // Binance format: [openTime, open, high, low, close, volume, closeTime, ...]
      const candles = raw.map(k => ({
        time: k[0],                          // openTime ms
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        timeISO: new Date(k[0]).toISOString()
      }));
      return res.status(200).json({ source: 'binance', symbol: 'XAUUSDT', interval, candles });
    }

    // Fallback: try GC=F (Gold Futures) from a public proxy
    throw new Error(`Binance returned ${resp.status}`);
  } catch (err) {
    // Fallback: try Binance spot with PAXG (gold-backed token)
    try {
      const paxgUrl = `https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${interval}&limit=${lim}`;
      const resp2 = await fetch(paxgUrl, { signal: AbortSignal.timeout(8000) });
      if (resp2.ok) {
        const raw = await resp2.json();
        const candles = raw.map(k => ({
          time: k[0],
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
          timeISO: new Date(k[0]).toISOString()
        }));
        return res.status(200).json({ source: 'binance-spot', symbol: 'PAXGUSDT', interval, candles, note: 'PAXG as gold proxy' });
      }
    } catch (err2) {
      // ignore
    }

    return res.status(502).json({ error: 'Failed to fetch candle data', detail: err.message });
  }
}
