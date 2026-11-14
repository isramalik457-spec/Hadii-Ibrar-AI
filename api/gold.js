
import { generateSignals } from "../lib/strategy.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      message: "Method not allowed"
    });
  }

  const BASE = "https://biquote.io/api/XAUUSD";

  try {
    const [quoteResponse, h4Response, m5Response] =
      await Promise.all([
        fetch(BASE),
        fetch(`${BASE}/ohlc?interval=4h&limit=100`),
        fetch(`${BASE}/ohlc?interval=5m&limit=200`)
      ]);

    if (!quoteResponse.ok || !h4Response.ok || !m5Response.ok) {
      throw new Error("BiQuote data request failed");
    }

    const [quote, h4Data, m5Data] = await Promise.all([
      quoteResponse.json(),
      h4Response.json(),
      m5Response.json()
    ]);

    const now = Date.now();
    const quoteAge = Number(quote.quoteAgeSeconds);

    const marketOpen =
      String(quote.marketState).toLowerCase() === "open";

    const quoteFresh =
      quote.stale === false &&
      Number.isFinite(quoteAge) &&
      quoteAge >= 0 &&
      quoteAge <= 180;

    const h4Bars = Array.isArray(h4Data.bars)
      ? h4Data.bars : [];

    const m5Bars = Array.isArray(m5Data.bars)
      ? m5Data.bars : [];

    function candleAgeMinutes(bars) {
      if (!bars.length || !bars[0].openTime) return Infinity;

      const time = Date.parse(bars[0].openTime);
      if (!Number.isFinite(time)) return Infinity;

      return (now - time) / 60000;
    }

    const h4Age = candleAgeMinutes(h4Bars);
    const m5Age = candleAgeMinutes(m5Bars);

    const candlesFresh =
      h4Age >= -5 && h4Age <= 480 &&
      m5Age >= -2 && m5Age <= 10;

    const canGenerateSignals =
      marketOpen &&
      quoteFresh &&
      candlesFresh &&
      h4Bars.length >= 3 &&
      m5Bars.length >= 3;

    // Strategy runs only when data is valid and live.
    const strategy = canGenerateSignals
      ? generateSignals(h4Bars, m5Bars)
      : { signals: [], message: "Signals blocked: market data is not live." };

    return res.status(200).json({
      success: true,
      symbol: "XAUUSD",
      source: quote.source || "BiQuote",
      marketStatus: marketOpen ? "OPEN" : "CLOSED",
      dataStatus: canGenerateSignals ? "LIVE" : "NOT LIVE",
      canGenerateSignals,

      quote: {
        bid: quote.bid,
        ask: quote.ask,
        spread: quote.spread,
        timestamp: quote.timestamp,
        stale: quote.stale,
        ageSeconds: quoteAge
      },

      timeframes: {
        H4: {
          interval: "4h",
          candleAgeMinutes: h4Age,
          candles: h4Bars
        },
        M5: {
          interval: "5m",
          candleAgeMinutes: m5Age,
          candles: m5Bars
        }
      },

      strategy,

      checkedAt: new Date(now).toISOString()
    });

  } catch (error) {
    return res.status(502).json({
      success: false,
      dataStatus: "CONNECTION ERROR",
      canGenerateSignals: false,
      strategy: { signals: [] },
      message: error.message
    });
  }
}
