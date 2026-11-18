
import { generateSignals } from "../lib/strategy.js";

const MAX_SPREAD = 0.30;
const MAX_QUOTE_AGE_SECONDS = 180;

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

    if (
      !quoteResponse.ok ||
      !h4Response.ok ||
      !m5Response.ok
    ) {
      throw new Error("BiQuote data request failed");
    }

    const [quote, h4Data, m5Data] = await Promise.all([
      quoteResponse.json(),
      h4Response.json(),
      m5Response.json()
    ]);

    const now = Date.now();

    // Validate live bid and ask.
    const bid = Number(quote.bid);
    const ask = Number(quote.ask);

    const validPrices =
      Number.isFinite(bid) &&
      Number.isFinite(ask) &&
      bid > 0 &&
      ask > 0 &&
      ask >= bid;

    // Use provider spread, or calculate from bid/ask.
    const providerSpread = Number(quote.spread);

    const spread = Number.isFinite(providerSpread)
      ? providerSpread
      : validPrices
        ? ask - bid
        : NaN;

    const spreadAllowed =
      Number.isFinite(spread) &&
      spread >= 0 &&
      spread <= MAX_SPREAD;

    const quoteAge = Number(quote.quoteAgeSeconds);

    const marketOpen =
      String(quote.marketState).toLowerCase() === "open";

    const quoteFresh =
      quote.stale === false &&
      Number.isFinite(quoteAge) &&
      quoteAge >= 0 &&
      quoteAge <= MAX_QUOTE_AGE_SECONDS;

    const h4Bars = Array.isArray(h4Data.bars)
      ? h4Data.bars
      : [];

    const m5Bars = Array.isArray(m5Data.bars)
      ? m5Data.bars
      : [];

    function candleAgeMinutes(bars) {
      if (!bars.length || !bars[0].openTime) {
        return Infinity;
      }

      const time = Date.parse(bars[0].openTime);

      if (!Number.isFinite(time)) {
        return Infinity;
      }

      return (now - time) / 60000;
    }

    const h4Age = candleAgeMinutes(h4Bars);
    const m5Age = candleAgeMinutes(m5Bars);

    const candlesFresh =
      h4Age >= -5 &&
      h4Age <= 480 &&
      m5Age >= -2 &&
      m5Age <= 10;

    const enoughCandles =
      h4Bars.length >= 5 &&
      m5Bars.length >= 40;

    const canGenerateSignals =
      marketOpen &&
      validPrices &&
      quoteFresh &&
      spreadAllowed &&
      candlesFresh &&
      enoughCandles;

    let blockReason = null;

    if (!marketOpen) {
      blockReason = "Market is closed";
    } else if (!validPrices) {
      blockReason = "Invalid live bid/ask prices";
    } else if (!quoteFresh) {
      blockReason = "Live quote is stale or unavailable";
    } else if (!spreadAllowed) {
      blockReason =
        `Spread ${Number.isFinite(spread) ? spread : "INVALID"} exceeds maximum ${MAX_SPREAD}`;
    } else if (!candlesFresh) {
      blockReason = "H4/M5 candle data is stale";
    } else if (!enoughCandles) {
      blockReason = "Not enough H4/M5 candles";
    }

    // Run the existing strategy only when all filters pass.
    const strategy = canGenerateSignals
      ? generateSignals(h4Bars, m5Bars)
      : {
          signals: [],
          message: blockReason || "Signal generation blocked"
        };

    return res.status(200).json({
      success: true,
      symbol: "XAUUSD",
      source: quote.source || "BiQuote",

      marketStatus: marketOpen ? "OPEN" : "CLOSED",

      dataStatus:
        quoteFresh && validPrices
          ? "LIVE"
          : "NOT LIVE",

      canGenerateSignals,

      signalBlockReason: blockReason,

      spreadFilter: {
        maximumAllowed: MAX_SPREAD,
        currentSpread: Number.isFinite(spread)
          ? Number(spread.toFixed(3))
          : null,
        allowed: spreadAllowed,
        status: spreadAllowed ? "PASS" : "BLOCKED"
      },

      quote: {
        bid: validPrices ? bid : null,
        ask: validPrices ? ask : null,
        spread: Number.isFinite(spread) ? spread : null,
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
      symbol: "XAUUSD",
      dataStatus: "CONNECTION ERROR",
      canGenerateSignals: false,
      spreadFilter: {
        maximumAllowed: MAX_SPREAD,
        allowed: false,
        status: "BLOCKED"
      },
      strategy: {
        signals: []
      },
      message: error.message
    });
  }
}
