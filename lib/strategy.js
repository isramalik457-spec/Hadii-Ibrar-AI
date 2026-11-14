
const MAX_SL_DISTANCE = 12;
const MIN_RR = 2;
const SL_BUFFER = 0.20;
const TOP_TOLERANCE = 1.50;

// Newest candle first from the API.
// Work with completed candles only.
function completedCandles(bars = []) {
  return bars
    .filter(c => c && c.isOpen !== true)
    .sort((a, b) => Date.parse(b.openTime) - Date.parse(a.openTime));
}

function candleType(c) {
  const body = Math.abs(c.close - c.open);
  const range = Math.max(c.high - c.low, 0.00001);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;

  const bullish = c.close > c.open;
  const bearish = c.close < c.open;

  const bullishEngulf =
    bullish && c.previous &&
    c.open <= c.previous.close &&
    c.close >= c.previous.open;

  const bearishEngulf =
    bearish && c.previous &&
    c.open >= c.previous.close &&
    c.close <= c.previous.open;

  const bullishPin = lower >= body * 2 && upper <= body;
  const bearishPin = upper >= body * 2 && lower <= body;

  const bullishRejection =
    bullish && lower >= range * 0.45;

  const bearishRejection =
    bearish && upper >= range * 0.45;

  return {
    bullish: bullishEngulf || bullishPin || bullishRejection,
    bearish: bearishEngulf || bearishPin || bearishRejection,
    engulfing: bullishEngulf || bearishEngulf,
    pinBar: bullishPin || bearishPin,
    rejection: bullishRejection || bearishRejection
  };
}

function findPattern(candles, direction) {
  const sample = candles.slice(1, 35);
  const pivots = [];

  for (let i = 1; i < sample.length - 1; i++) {
    const c = sample[i];
    const before = sample[i - 1];
    const after = sample[i + 1];

    const isPivot = direction === "SELL"
      ? c.high >= before.high && c.high >= after.high
      : c.low <= before.low && c.low <= after.low;

    if (isPivot) pivots.push(direction === "SELL" ? c.high : c.low);
  }

  if (pivots.length < 2) return false;

  const recent = pivots.slice(0, 3);
  const max = Math.max(...recent);
  const min = Math.min(...recent);

  return max - min <= TOP_TOLERANCE;
}

function findTargets(h4, entry, direction) {
  const levels = [];

  for (const c of h4.slice(1, 30)) {
    if (direction === "BUY") {
      if (c.high > entry) levels.push(c.high);
    } else {
      if (c.low < entry) levels.push(c.low);
    }
  }

  const unique = [...new Set(levels)].sort((a, b) =>
    direction === "BUY" ? a - b : b - a
  );

  return {
    tp1: unique[0] ?? null,
    tp2: unique[1] ?? null
  };
}

function buildSignal(direction, setup, candle, h4) {
  const entry = candle.close;

  const sl = direction === "BUY"
    ? candle.low - SL_BUFFER
    : candle.high + SL_BUFFER;

  const distance = Math.abs(entry - sl);

  if (!Number.isFinite(distance) ||
      distance <= 0 ||
      distance > MAX_SL_DISTANCE) {
    return null;
  }

  const targets = findTargets(h4, entry, direction);

  const risk = distance;
  const fallbackTP = direction === "BUY"
    ? entry + risk * MIN_RR
    : entry - risk * MIN_RR;

  const tp1 = targets.tp1 ?? fallbackTP;
  const reward = Math.abs(tp1 - entry);

  if (reward / risk < MIN_RR) return null;

  const tp2 = targets.tp2;

  return {
    direction,
    setup,
    entry,
    sl,
    tp1,
    tp2,
    riskDistance: Number(distance.toFixed(2)),
    rewardRisk: Number((reward / risk).toFixed(2)),
    confirmation: "M5 candle closed",
    status: "SIGNAL"
  };
}

export function generateSignals(h4Bars = [], m5Bars = []) {
  const h4 = completedCandles(h4Bars);
  const m5 = completedCandles(m5Bars);

  if (h4.length < 3 || m5.length < 3) {
    return {
      signals: [],
      message: "Not enough completed candles"
    };
  }

  const current = {
    ...m5[0],
    previous: m5[1]
  };

  const confirmation = candleType(current);
  const previous = m5[1];
  const older = m5[2];

  const signals = [];
  const h4High = h4[1].high;
  const h4Low = h4[1].low;

  // Two-candle H4 liquidity sweep.
  const sellSweep =
    previous.close > h4High &&
    current.close < h4High &&
    confirmation.bearish;

  const buySweep =
    previous.close < h4Low &&
    current.close > h4Low &&
    confirmation.bullish;

  if (sellSweep) {
    const s = buildSignal("SELL", "H4 HIGH LIQUIDITY SWEEP", current, h4);
    if (s) signals.push(s);
  }

  if (buySweep) {
    const s = buildSignal("BUY", "H4 LOW LIQUIDITY SWEEP", current, h4);
    if (s) signals.push(s);
  }

  // Double / triple top and bottom with M5 confirmation.
  if (confirmation.bearish && findPattern(m5, "SELL")) {
    const s = buildSignal("SELL", "DOUBLE / TRIPLE TOP", current, h4);
    if (s) signals.push(s);
  }

  if (confirmation.bullish && findPattern(m5, "BUY")) {
    const s = buildSignal("BUY", "DOUBLE / TRIPLE BOTTOM", current, h4);
    if (s) signals.push(s);
  }

  return {
    signals,
    message: signals.length
      ? "Confirmed M5 setup found"
      : "No valid setup found"
  };
}
