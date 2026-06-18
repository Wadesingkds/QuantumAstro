/**
 * /api/candles.js — Proxy fetch XAUUSD OHLC candles
 * Sources (priority order):
 *   1. Binance Futures XAUUSDT
 *   2. Binance Spot PAXGUSDT (gold-backed token)
 *   3. CoinGecko PAXG market_chart → derived OHLC (works for any timeframe)
 *   4. CoinGecko PAXG OHLC (only for 30m+ timeframes)
 *   5. Yahoo Finance XAUUSD=X
 * Query: ?interval=15m&limit=200
 */

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { interval = '15m', limit = '200' } = req.query;

  const validIntervals = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d'];
  if (!validIntervals.includes(interval)) {
    return res.status(400).json({ error: 'Invalid interval' });
  }

  const lim = Math.min(parseInt(limit) || 200, 500);
  const errors = [];

  // ── Source 1: Binance Futures XAUUSDT ──
  try {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=XAUUSDT&interval=${interval}&limit=${lim}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (resp.ok) {
      const raw = await resp.json();
      const candles = raw.map(k => ({
        time: k[0],
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        timeISO: new Date(k[0]).toISOString()
      }));
      return res.status(200).json({ source: 'binance-futures', symbol: 'XAUUSDT', interval, candles });
    }
    errors.push(`binance-futures: HTTP ${resp.status}`);
  } catch (err) {
    errors.push(`binance-futures: ${err.message}`);
  }

  // ── Source 2: Binance Spot PAXGUSDT ──
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=PAXGUSDT&interval=${interval}&limit=${lim}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (resp.ok) {
      const raw = await resp.json();
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
    errors.push(`binance-spot: HTTP ${resp.status}`);
  } catch (err) {
    errors.push(`binance-spot: ${err.message}`);
  }

  // ── Source 3: CoinGecko PAXG market_chart (works for ALL timeframes) ──
  // Returns ~5min price snapshots which we aggregate into target timeframe OHLC
  try {
    // Map our interval to CoinGecko days parameter
    // market_chart supports days 1, 7, 14, 30, 90, 180, 365
    const cgDaysMap = {
      '5m': 1, '15m': 1, '30m': 1, '1h': 1,
      '2h': 7, '4h': 14, '6h': 14, '8h': 14,
      '12h': 14, '1d': 30
    };
    const cgDays = cgDaysMap[interval] || 1;
    const url = `https://api.coingecko.com/api/v3/coins/pax-gold/market_chart?vs_currency=usd&days=${cgDays}`;
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });

    if (resp.ok) {
      const data = await resp.json();
      const prices = data?.prices || [];
      if (prices.length < 10) throw new Error('Insufficient market_chart data: ' + prices.length);

      // prices format: [[timestamp_ms, price], ...] at ~5min intervals
      // Convert to candles, then aggregate to target interval
      const rawCandles = prices.map(p => ({
        time: p[0],
        open: p[1],
        high: p[1],
        low: p[1],
        close: p[1],
        volume: 0
      }));

      const aggregated = aggregateCandles(rawCandles, interval);
      const trimmed = aggregated.slice(-lim);

      if (trimmed.length < 10) throw new Error('After aggregation insufficient: ' + trimmed.length);

      return res.status(200).json({
        source: 'coingecko-paxg',
        symbol: 'PAXG',
        interval,
        candles: trimmed,
        note: 'PAXG gold-backed token, OHLC derived from market_chart'
      });
    }
    errors.push(`coingecko-market: HTTP ${resp.status}`);
  } catch (err) {
    errors.push(`coingecko-market: ${err.message}`);
  }

  // ── Source 4: Yahoo Finance XAUUSD=X ──
  try {
    const yahooIntervalMap = {
      '1m': '1m', '3m': '5m', '5m': '5m', '15m': '15m',
      '30m': '30m', '1h': '60m', '2h': '60m', '4h': '60m',
      '6h': '60m', '8h': '60m', '12h': '60m', '1d': '1d'
    };
    const yInterval = yahooIntervalMap[interval] || '15m';
    const yahooRange = lim <= 60 ? '5d' : lim <= 200 ? '1mo' : '3mo';

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=${yInterval}&range=${yahooRange}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000)
    });

    if (resp.ok) {
      const data = await resp.json();
      const result = data?.chart?.result?.[0];
      if (!result) throw new Error('No data in Yahoo response');

      const timestamps = result.timestamp || [];
      const quote = result.indicators?.quote?.[0] || {};
      const opens = quote.open || [];
      const highs = quote.high || [];
      const lows = quote.low || [];
      const closes = quote.close || [];
      const volumes = quote.volume || [];

      const candles = [];
      for (let i = 0; i < timestamps.length; i++) {
        if (opens[i] == null || highs[i] == null || lows[i] == null || closes[i] == null) continue;
        const timeMs = timestamps[i] * 1000;
        candles.push({
          time: timeMs,
          open: parseFloat(opens[i]),
          high: parseFloat(highs[i]),
          low: parseFloat(lows[i]),
          close: parseFloat(closes[i]),
          volume: parseFloat(volumes[i] || 0),
          timeISO: new Date(timeMs).toISOString()
        });
      }

      const trimmed = candles.slice(-lim);
      if (trimmed.length < 10) throw new Error('Insufficient Yahoo candles');

      return res.status(200).json({
        source: 'yahoo-finance',
        symbol: 'XAUUSD=X',
        interval: yInterval,
        candles: trimmed
      });
    }
    errors.push(`yahoo: HTTP ${resp.status}`);
  } catch (err) {
    errors.push(`yahoo: ${err.message}`);
  }

  // ── All sources failed ──
  return res.status(502).json({
    error: 'All data sources failed',
    detail: errors.join(' | ')
  });
}

// Aggregate raw candles into our target timeframe (proper OHLC)
function aggregateCandles(candles, targetInterval) {
  const intervalMs = {
    '5m': 5 * 60000, '15m': 15 * 60000, '30m': 30 * 60000,
    '1h': 60 * 60000, '2h': 120 * 60000, '4h': 240 * 60000,
    '6h': 360 * 60000, '8h': 480 * 60000, '12h': 720 * 60000, '1d': 1440 * 60000
  };
  const target = intervalMs[targetInterval] || 15 * 60000;

  if (candles.length < 2) return candles.map(c => ({ ...c, timeISO: new Date(c.time).toISOString() }));

  const result = [];
  let bucket = null;
  for (const c of candles) {
    // Round down to target interval boundary
    const bucketStart = Math.floor(c.time / target) * target;
    if (!bucket || bucket.time !== bucketStart) {
      if (bucket) result.push(bucket);
      bucket = { time: bucketStart, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      bucket.high = Math.max(bucket.high, c.high);
      bucket.low = Math.min(bucket.low, c.low);
      bucket.close = c.close;
      bucket.volume += c.volume;
    }
  }
  if (bucket) result.push(bucket);

  return result.map(c => ({ ...c, timeISO: new Date(c.time).toISOString() }));
}
