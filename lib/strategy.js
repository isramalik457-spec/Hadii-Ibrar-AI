
const MAX_SL_DISTANCE = 12;
const MIN_RR = 2;
const SL_BUFFER = 0.20;
const TOP_TOLERANCE = 1.50;

function completedCandles(bars = []) {
  return bars
    .filter(c => c && c.isOpen !== true)
    .sort((a, b) => Date.parse(b.openTime) - Date.parse(a.openTime));
}

function overlaps(a, b) {
  return a.low <= b.high && a.high >= b.low;
}

function candleType(c) {
  const body = Math.max(Math.abs(c.close - c.open), 0.00001);
  const range = Math.max(c.high - c.low, 0.00001);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;

  const bullish = c.close > c.open;
  const bearish = c.close < c.open;

  const bullishEngulf = bullish && c.previous &&
    c.open <= c.previous.close &&
    c.close >= c.previous.open;

  const bearishEngulf = bearish && c.previous &&
    c.open >= c.previous.close &&
    c.close <= c.previous.open;

  const bullishPin =
    lower >= body * 2 && lower >= range * 0.35 &&
    upper <= range * 0.25;

  const bearishPin =
    upper >= body * 2 && upper >= range * 0.35 &&
    lower <= range * 0.25;

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
  const sample = candles.slice(1, 40);
  const pivots = [];

  for (let i = 1; i < sample.length - 1; i++) {
    const c = sample[i];
    const before = sample[i - 1];
    const after = sample[i + 1];

    const pivot = direction === "SELL"
      ? c.high >= before.high && c.high >= after.high
      : c.low <= before.low && c.low <= after.low;

    if (pivot) {
      pivots.push(direction === "SELL" ? c.high : c.low);
    }
  }

  if (pivots.length < 2) return false;

  const recent = pivots.slice(0, 3);
  const highest = Math.max(...recent);
  const lowest = Math.min(...recent);

  const patternArea = direction === "SELL"
    ? candles[0].high
    : candles[0].low;

  return (
    highest - lowest <= TOP_TOLERANCE &&
    Math.abs(patternArea - (highest + lowest) / 2) <= TOP_TOLERANCE
  );
}

function getH4Levels(h4) {
  const levels = [];

  h4.slice(0, 30).forEach((c, i) => {
    levels.push(c.high, c.low);

    if (i === 0) {
      levels.push(c.open, c.close);
    }
  });

  return [...new Set(levels.filter(Number.isFinite))];
}

function nearH4Level(zone, levels) {
  const midpoint = (zone.low + zone.high) / 2;

  return levels.some(level =>
    Math.abs(midpoint - level) <= TOP_TOLERANCE
  );
}

// Detect untested M5 Order Blocks.
function findOrderBlock(m5, direction) {
  const current = m5[0];

  for (let i = 1; i < Math.min(m5.length - 2, 80); i++) {
    const impulse = m5[i];
    const base = m5[i + 1];

    const bullishOB =
      direction === "BUY" &&
      impulse.close > impulse.open &&
      impulse.close > base.high;

    const bearishOB =
      direction === "SELL" &&
      impulse.close < impulse.open &&
      impulse.close < base.low;

    if (!bullishOB && !bearishOB) continue;

    const zone = direction === "BUY"
      ? { low: base.low, high: base.open }
      : { low: base.open, high: base.high };

    if (zone.low >= zone.high) continue;

    // No previous retest between formation and current candle.
    const alreadyTested = m5
      .slice(1, i + 1)
      .some(c => overlaps(c, zone));

    if (alreadyTested) continue;

    if (overlaps(current, zone)) return zone;
  }

  return null;
}

// Detect untested M5 Fair Value Gaps.
function findFVG(m5, direction) {
  const current = m5[0];

  for (let i = 1; i < Math.min(m5.length - 2, 80); i++) {
    const newer = m5[i];
    const older = m5[i + 2];

    let zone = null;

    if (direction === "BUY" && newer.low > older.high) {
      zone = { low: older.high, high: newer.low };
    }

    if (direction === "SELL" && newer.high < older.low) {
      zone = { low: newer.high, high: older.low };
    }

    if (!zone || zone.low >= zone.high) continue;

    const alreadyTested = m5
      .slice(1, i + 1)
      .some(c => overlaps(c, zone));

    if (alreadyTested) continue;

    if (overlaps(current, zone)) return zone;
  }

  return null;
}

function findTargets(h4, entry, direction, risk) {
  const levels = [];

  h4.slice(0, 30).forEach(c => {
    if (direction === "BUY" && c.high > entry) {
      levels.push(c.high);
    }

    if (direction === "SELL" && c.low < entry) {
      levels.push(c.low);
    }
  });

  const unique = [...new Set(levels)];

  const valid = unique
    .filter(level =>
      Math.abs(level - entry) / risk >= MIN_RR
    )
    .sort((a, b) =>
      direction === "BUY" ? a - b : b - a
    );

  const fallback = direction === "BUY"
    ? entry + risk * MIN_RR
    : entry - risk * MIN_RR;

  return {
    tp1: valid[0] ?? fallback,
    tp2: valid[1] ?? null
  };
}

function buildSignal(direction, setup, candle, h4, zone = null) {
  const entry = candle.close;

  const sl = direction === "BUY"
    ? Math.min(candle.low, zone?.low ?? candle.low) - SL_BUFFER
    : Math.max(candle.high, zone?.high ?? candle.high) + SL_BUFFER;

  const distance = Math.abs(entry - sl);

  if (
    !Number.isFinite(distance) ||
    distance <= 0 ||
    distance > MAX_SL_DISTANCE
  ) return null;

  const targets = findTargets(h4, entry, direction, distance);
  const reward = Math.abs(targets.tp1 - entry);

  if (reward / distance < MIN_RR) return null;

  return {
    direction,
    setup,
    entry: Number(entry.toFixed(3)),
    sl: Number(sl.toFixed(3)),
    tp1: Number(targets.tp1.toFixed(3)),
    tp2: targets.tp2 === null
      ? null
      : Number(targets.tp2.toFixed(3)),
    riskDistance: Number(distance.toFixed(2)),
    rewardRisk: Number((reward / distance).toFixed(2)),
    confirmation: "Completed M5 candle",
    status: "SIGNAL"
  };
}

export function generateSignals(h4Bars = [], m5Bars = []) {
  const h4 = completedCandles(h4Bars);
  const m5 = completedCandles(m5Bars);

  if (h4.length < 3 || m5.length < 40) {
    return {
      signals: [],
      message: "Not enough completed candles"
    };
  }

  const current = {
    ...m5[0],
    previous: m5[1]
  };

  const previous = m5[1];
  const confirmation = candleType(current);
  const h4High = h4[0].high;
  const h4Low = h4[0].low;
  const levels = getH4Levels(h4);

  const signals = [];

  function add(direction, setup, zone = null) {
    const signal = buildSignal(
      direction, setup, current, h4, zone
    );

    if (signal) signals.push(signal);
  }

  // Two-candle H4 liquidity sweep.
  if (
    previous.close > h4High &&
    current.close < h4High &&
    confirmation.bearish
  ) {
    add("SELL", "H4 HIGH LIQUIDITY SWEEP");
  }

  if (
    previous.close < h4Low &&
    current.close > h4Low &&
    confirmation.bullish
  ) {
    add("BUY", "H4 LOW LIQUIDITY SWEEP");
  }

  // Double / Triple Top and Bottom.
  if (confirmation.bearish && findPattern(m5, "SELL")) {
    add("SELL", "DOUBLE / TRIPLE TOP");
  }

  if (confirmation.bullish && findPattern(m5, "BUY")) {
    add("BUY", "DOUBLE / TRIPLE BOTTOM");
  }

  // Order Block retest near H4 levels.
  for (const direction of ["BUY", "SELL"]) {
    const ob = findOrderBlock(m5, direction);

    if (
      ob &&
      nearH4Level(ob, levels) &&
      (direction === "BUY"
        ? confirmation.bullish
        : confirmation.bearish)
    ) {
      add(direction, "M5 ORDER BLOCK RETEST", ob);
    }

    // Fair Value Gap retest near H4 levels.
    const fvg = findFVG(m5, direction);

    if (
      fvg &&
      nearH4Level(fvg, levels) &&
      (direction === "BUY"
        ? confirmation.bullish
        : confirmation.bearish)
    ) {
      add(direction, "M5 FVG RETEST", fvg);
    }
  }

  // Remove duplicate signals with same direction and setup.
  const uniqueSignals = signals.filter((signal, index, array) =>
    array.findIndex(s =>
      s.direction === signal.direction &&
      s.setup === signal.setup
    ) === index
  );

  return {
    signals: uniqueSignals,
    message: uniqueSignals.length
      ? "Confirmed M5 setup found"
      : "No valid setup found",
    rules: {
      maxSLDistance: MAX_SL_DISTANCE,
      minimumRR: MIN_RR,
      confirmationTimeframe: "M5",
      contextTimeframe: "H4"
    }
  };
}
