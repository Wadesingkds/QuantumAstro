/**
 * /api/candles.js — Proxy fetch XAUUSD OHLC candles
 * Sources: Binance Futures (XAUUSDT) → Binance Spot (PAXGUSDT) → Yahoo Finance (XAUUSD=X)
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

  // Validate interval
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

  // ── Source 2: Binance Spot PAXGUSDT (gold-backed token proxy) ──
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

  // ── Source 3: Yahoo Finance XAUUSD=X ──
  try {
    // Map our intervals to Yahoo Finance format
    const yahooIntervalMap = {
      '1m': '1m', '3m': '5m', '5m': '5m', '15m': '15m',
      '30m': '30m', '1h': '60m', '2h': '60m', '4h': '60m',
      '6h': '60m', '8h': '60m', '12h': '60m', '1d': '1d'
    };
    const yInterval = yahooIntervalMap[interval] || '15m';
    const yahooRange = lim <= 60 ? '5d' : lim <= 200 ? '1mo' : '3mo';

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=${yInterval}&range=${yahooRange}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuantumAstro/1.0)' },
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

      // Trim to limit
      const trimmed = candles.slice(-lim);

      if (trimmed.length < 10) throw new Error('Insufficient Yahoo candles: ' + trimmed.length);

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
