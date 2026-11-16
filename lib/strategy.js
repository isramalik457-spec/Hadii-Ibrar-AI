
const MAX_SL_DISTANCE = 12;
const MIN_RR = 2;
const PREFERRED_RR = 3;
const SL_BUFFER = 0.20;
const TOP_TOLERANCE = 1.50;
const LOOKBACK = 80;

// ==========================================
// 1. CANDLE DATA
// ==========================================

function completedCandles(bars = []) {
  return bars
    .filter(c =>
      c &&
      c.isOpen !== true &&
      c.open != null &&
      c.high != null &&
      c.low != null &&
      c.close != null &&
      [c.open, c.high, c.low, c.close].every(
        v => Number.isFinite(Number(v))
      ) &&
      Number.isFinite(Date.parse(c.openTime)) &&
      Number(c.high) >= Number(c.low)
    )
    .map(c => ({
      ...c,
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close)
    }))
    .sort((a, b) =>
      Date.parse(b.openTime) - Date.parse(a.openTime)
    );
}

function overlaps(a, b) {
  return a.low <= b.high && a.high >= b.low;
}

function middle(zone) {
  return (zone.low + zone.high) / 2;
}

function uniqueNumbers(values) {
  return [...new Set(values.filter(Number.isFinite))];
}

// ==========================================
// 2. M5 CONFIRMATION CANDLES
// ==========================================

function candleType(c) {
  const body = Math.max(
    Math.abs(c.close - c.open),
    0.00001
  );

  const range = Math.max(
    c.high - c.low,
    0.00001
  );

  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;

  const bullish = c.close > c.open;
  const bearish = c.close < c.open;

  const bullishEngulf =
    bullish &&
    c.previous &&
    c.open <= c.previous.close &&
    c.close >= c.previous.open;

  const bearishEngulf =
    bearish &&
    c.previous &&
    c.open >= c.previous.close &&
    c.close <= c.previous.open;

  const bullishPin =
    lower >= body * 2 &&
    lower >= range * 0.35 &&
    upper <= range * 0.25;

  const bearishPin =
    upper >= body * 2 &&
    upper >= range * 0.35 &&
    lower <= range * 0.25;

  const bullishRejection =
    bullish && lower >= range * 0.45;

  const bearishRejection =
    bearish && upper >= range * 0.45;

  return {
    bullish:
      bullishEngulf ||
      bullishPin ||
      bullishRejection,

    bearish:
      bearishEngulf ||
      bearishPin ||
      bearishRejection,

    engulfing:
      bullishEngulf || bearishEngulf,

    pinBar:
      bullishPin || bearishPin,

    rejection:
      bullishRejection || bearishRejection
  };
}

// ==========================================
// 3. SWING HIGH / LOW
// ==========================================

function findPivots(candles, limit = LOOKBACK) {
  const highs = [];
  const lows = [];

  const sample = candles.slice(0, limit);

  for (let i = 1; i < sample.length - 1; i++) {
    const c = sample[i];
    const newer = sample[i - 1];
    const older = sample[i + 1];

    if (
      c.high >= newer.high &&
      c.high >= older.high
    ) {
      highs.push({
        price: c.high,
        time: c.openTime
      });
    }

    if (
      c.low <= newer.low &&
      c.low <= older.low
    ) {
      lows.push({
        price: c.low,
        time: c.openTime
      });
    }
  }

  return { highs, lows };
}

// ==========================================
// 4. DOUBLE / TRIPLE TOP & BOTTOM
// ==========================================

function findPattern(candles, direction) {
  const pivots = findPivots(candles, 40);

  const points = direction === "SELL"
    ? pivots.highs
    : pivots.lows;

  if (points.length < 2) return false;

  const recent = points.slice(0, 3);
  const prices = recent.map(p => p.price);

  const highest = Math.max(...prices);
  const lowest = Math.min(...prices);

  const current = candles[0];

  const patternPrice = direction === "SELL"
    ? current.high
    : current.low;

  return (
    highest - lowest <= TOP_TOLERANCE &&
    Math.abs(
      patternPrice - (highest + lowest) / 2
    ) <= TOP_TOLERANCE
  );
}

// ==========================================
// 5. UNTESTED ORDER BLOCK
// ==========================================

function findOrderBlock(candles, direction) {
  const current = candles[0];

  for (
    let i = 2;
    i < Math.min(candles.length - 1, LOOKBACK);
    i++
  ) {
    const impulse = candles[i - 1];
    const base = candles[i];

    const bullishOB =
      direction === "BUY" &&
      base.close < base.open &&
      impulse.close > impulse.open &&
      impulse.close > base.high;

    const bearishOB =
      direction === "SELL" &&
      base.close > base.open &&
      impulse.close < impulse.open &&
      impulse.close < base.low;

    if (!bullishOB && !bearishOB) continue;

    const zone = direction === "BUY"
      ? {
          low: base.low,
          high: base.open
        }
      : {
          low: base.open,
          high: base.high
        };

    if (zone.low >= zone.high) continue;

    const alreadyTested = candles
      .slice(1, i - 1)
      .some(c => overlaps(c, zone));

    if (alreadyTested) continue;

    if (overlaps(current, zone)) {
      return zone;
    }
  }

  return null;
}

// ==========================================
// 6. UNTESTED FAIR VALUE GAP
// ==========================================

function findFVG(candles, direction) {
  const current = candles[0];

  for (
    let i = 2;
    i < Math.min(candles.length - 2, LOOKBACK);
    i++
  ) {
    const newer = candles[i - 1];
    const older = candles[i + 1];

    let zone = null;

    if (
      direction === "BUY" &&
      newer.low > older.high
    ) {
      zone = {
        low: older.high,
        high: newer.low
      };
    }

    if (
      direction === "SELL" &&
      newer.high < older.low
    ) {
      zone = {
        low: newer.high,
        high: older.low
      };
    }

    if (!zone || zone.low >= zone.high) continue;

    const alreadyTested = candles
      .slice(1, i - 1)
      .some(c => overlaps(c, zone));

    if (alreadyTested) continue;

    if (overlaps(current, zone)) {
      return zone;
    }
  }

  return null;
}

// ==========================================
// 7. H4 ORDER BLOCKS & FVG ZONES
// ==========================================

function getH4Zones(h4) {
  const orderBlocks = [];
  const fvgs = [];

  for (
    let i = 2;
    i < Math.min(h4.length - 1, 40);
    i++
  ) {
    const impulse = h4[i - 1];
    const base = h4[i];

    if (
      base.close < base.open &&
      impulse.close > impulse.open &&
      impulse.close > base.high
    ) {
      orderBlocks.push({
        low: base.low,
        high: base.open,
        type: "BUY OB"
      });
    }

    if (
      base.close > base.open &&
      impulse.close < impulse.open &&
      impulse.close < base.low
    ) {
      orderBlocks.push({
        low: base.open,
        high: base.high,
        type: "SELL OB"
      });
    }

    const newer = h4[i - 1];
    const older = h4[i + 1];

    if (newer.low > older.high) {
      fvgs.push({
        low: older.high,
        high: newer.low,
        type: "BULLISH FVG"
      });
    }

    if (newer.high < older.low) {
      fvgs.push({
        low: newer.high,
        high: older.low,
        type: "BEARISH FVG"
      });
    }
  }

  return { orderBlocks, fvgs };
}

// ==========================================
// 8. H4 CONTEXT AND LEVELS
// ==========================================

function getH4Context(h4) {
  const levels = [];

  h4.slice(0, 30).forEach((c, i) => {
    levels.push(c.high, c.low);

    if (i === 0) {
      levels.push(c.open, c.close);
    }
  });

  const pivots = findPivots(h4, 30);

  pivots.highs.forEach(p => levels.push(p.price));
  pivots.lows.forEach(p => levels.push(p.price));

  const zones = getH4Zones(h4);

  zones.orderBlocks.forEach(z => {
    levels.push(z.low, z.high);
  });

  zones.fvgs.forEach(z => {
    levels.push(z.low, z.high);
  });

  return {
    levels: uniqueNumbers(levels),
    highs: pivots.highs.map(p => p.price),
    lows: pivots.lows.map(p => p.price),
    orderBlocks: zones.orderBlocks,
    fvgs: zones.fvgs
  };
}

function nearH4Context(zone, context) {
  const price = middle(zone);

  const nearLevel = context.levels.some(level =>
    Math.abs(price - level) <= TOP_TOLERANCE
  );

  const allZones = [
    ...context.orderBlocks,
    ...context.fvgs
  ];

  const nearZone = allZones.some(h4Zone =>
    overlaps(zone, h4Zone) ||
    Math.abs(price - middle(h4Zone)) <= TOP_TOLERANCE
  );

  return nearLevel || nearZone;
}

// ==========================================
// 9. H4 LIQUIDITY SWEEP LEVELS
// ==========================================

function getH4SweepLevels(h4) {
  const levels = [];

  function h4CloseTime(candle) {
    const time = Date.parse(candle.openTime);

    return Number.isFinite(time)
      ? time + 4 * 60 * 60 * 1000
      : null;
  }

  if (!h4.length) return levels;

  // Latest completed H4 candle High and Low.
  const latestAvailable = h4CloseTime(h4[0]);

  if (latestAvailable !== null) {
    levels.push({
      price: h4[0].high,
      side: "HIGH",
      availableAt: latestAvailable
    });

    levels.push({
      price: h4[0].low,
      side: "LOW",
      availableAt: latestAvailable
    });
  }

  // Important confirmed H4 swing High and Low.
  for (
    let i = 1;
    i < Math.min(h4.length - 1, 30);
    i++
  ) {
    const candle = h4[i];
    const newer = h4[i - 1];
    const older = h4[i + 1];

    const availableAt = h4CloseTime(newer);

    if (availableAt === null) continue;

    if (
      candle.high >= newer.high &&
      candle.high >= older.high
    ) {
      levels.push({
        price: candle.high,
        side: "HIGH",
        availableAt
      });
    }

    if (
      candle.low <= newer.low &&
      candle.low <= older.low
    ) {
      levels.push({
        price: candle.low,
        side: "LOW",
        availableAt
      });
    }
  }

  return levels.filter((level, index, array) =>
    array.findIndex(item =>
      item.side === level.side &&
      item.price === level.price
    ) === index
  );
}

// ==========================================
// 10. TARGET CALCULATION
// ==========================================

function selectTargets(
  candidates,
  entry,
  risk,
  direction
) {
  const valid = uniqueNumbers(candidates)
    .filter(price => {
      const distance = direction === "BUY"
        ? price - entry
        : entry - price;

      return distance > 0 &&
        distance / risk >= MIN_RR;
    })
    .sort((a, b) =>
      direction === "BUY" ? a - b : b - a
    );

  return {
    tp1: valid[0] ?? null,
    tp2: valid[1] ?? null
  };
}

// Intraday TP1 = H4 candle High / Low.
// Intraday TP2 = next H4 zone / level.
function intradayTargets(h4, entry, risk, direction) {
  const candleLevels = [];

  h4.slice(0, 30).forEach(c => {
    if (direction === "BUY" && c.high > entry) {
      candleLevels.push(c.high);
    }

    if (direction === "SELL" && c.low < entry) {
      candleLevels.push(c.low);
    }
  });

  const tp1Result = selectTargets(
    candleLevels,
    entry,
    risk,
    direction
  );

  if (tp1Result.tp1 === null) {
    return { tp1: null, tp2: null };
  }

  const zones = getH4Zones(h4);

  const nextZoneLevels = [
    ...h4.map(c =>
      direction === "BUY" ? c.high : c.low
    ),
    ...zones.orderBlocks.flatMap(z => [z.low, z.high]),
    ...zones.fvgs.flatMap(z => [z.low, z.high])
  ];

  const tp2Candidates = nextZoneLevels.filter(price =>
    direction === "BUY"
      ? price > tp1Result.tp1
      : price < tp1Result.tp1
  );

  const tp2Result = selectTargets(
    tp2Candidates,
    entry,
    risk,
    direction
  );

  return {
    tp1: tp1Result.tp1,
    tp2: tp2Result.tp1
  };
}

// Scalping TP1 / TP2 = nearest valid M5 swing levels.
function m5Targets(m5, entry, risk, direction) {
  const pivots = findPivots(m5, 60);

  const candidates = direction === "BUY"
    ? pivots.highs.map(p => p.price)
    : pivots.lows.map(p => p.price);

  return selectTargets(
    candidates,
    entry,
    risk,
    direction
  );
}

// Liquidity Sweep TP1 = nearest M5 support/resistance.
// TP2 = H4 opposite level / next zone.
function sweepTargets(
  h4,
  m5,
  entry,
  risk,
  direction
) {
  const firstTarget = m5Targets(
    m5,
    entry,
    risk,
    direction
  );

  if (firstTarget.tp1 === null) {
    return { tp1: null, tp2: null };
  }

  const context = getH4Context(h4);

  const h4Candidates = direction === "SELL"
    ? [
        ...h4.map(c => c.low),
        ...context.lows,
        ...context.orderBlocks.map(z => z.low),
        ...context.fvgs.map(z => z.low)
      ]
    : [
        ...h4.map(c => c.high),
        ...context.highs,
        ...context.orderBlocks.map(z => z.high),
        ...context.fvgs.map(z => z.high)
      ];

  const beyondTP1 = h4Candidates.filter(price =>
    direction === "SELL"
      ? price < firstTarget.tp1
      : price > firstTarget.tp1
  );

  const secondTarget = selectTargets(
    beyondTP1,
    entry,
    risk,
    direction
  );

  return {
    tp1: firstTarget.tp1,
    tp2: secondTarget.tp1
  };
}

// ==========================================
// 11. COMMON SIGNAL BUILDER
// ==========================================

function buildSignal({
  direction,
  strategy,
  setup,
  candle,
  h4,
  m5,
  sl,
  targetMode
}) {
  const entry = candle.close;
  const distance = Math.abs(entry - sl);

  if (
    !Number.isFinite(distance) ||
    distance <= 0 ||
    distance > MAX_SL_DISTANCE
  ) {
    return null;
  }

  let targets;

  if (targetMode === "INTRADAY") {
    targets = intradayTargets(
      h4,
      entry,
      distance,
      direction
    );
  } else if (targetMode === "SWEEP") {
    targets = sweepTargets(
      h4,
      m5,
      entry,
      distance,
      direction
    );
  } else {
    targets = m5Targets(
      m5,
      entry,
      distance,
      direction
    );
  }

  // No artificial target fallback.
  if (targets.tp1 === null) return null;

  const reward = Math.abs(targets.tp1 - entry);
  const rr = reward / distance;

  if (rr < MIN_RR) return null;

  return {
    id: [
      candle.openTime,
      strategy,
      direction,
      setup
    ].join("_"),

    strategy,
    direction,
    setup,

    entry: Number(entry.toFixed(3)),
    sl: Number(sl.toFixed(3)),

    tp1: Number(targets.tp1.toFixed(3)),

    tp2: targets.tp2 === null
      ? null
      : Number(targets.tp2.toFixed(3)),

    // TP3 requires opposite intraday signal tracking.
    tp3: null,

    riskDistance: Number(distance.toFixed(2)),
    rewardRisk: Number(rr.toFixed(2)),

    confirmation: "Completed M5 candle",
    signalTime: candle.openTime,
    status: "SIGNAL"
  };
}

// ==========================================
// 12. STRATEGY 1 - INTRADAY
// ==========================================

function detectIntraday(h4, m5, context) {
  const current = m5[0];
  const confirmation = candleType(current);
  const signals = [];

  function add(direction, setup, zone = null) {
    const sl = direction === "BUY"
      ? Math.min(
          current.low,
          zone ? zone.low : current.low
        ) - SL_BUFFER
      : Math.max(
          current.high,
          zone ? zone.high : current.high
        ) + SL_BUFFER;

    const signal = buildSignal({
      direction,
      strategy: "INTRADAY",
      setup,
      candle: current,
      h4,
      m5,
      sl,
      targetMode: "INTRADAY"
    });

    if (signal) signals.push(signal);
  }

  // Double / Triple Top = SELL.
  if (
    confirmation.bearish &&
    findPattern(m5, "SELL")
  ) {
    add("SELL", "DOUBLE / TRIPLE TOP");
  }

  // Double / Triple Bottom = BUY.
  if (
    confirmation.bullish &&
    findPattern(m5, "BUY")
  ) {
    add("BUY", "DOUBLE / TRIPLE BOTTOM");
  }

  // OB and FVG retests near H4 context.
  for (const direction of ["BUY", "SELL"]) {
    const validConfirmation = direction === "BUY"
      ? confirmation.bullish
      : confirmation.bearish;

    if (!validConfirmation) continue;

    const ob = findOrderBlock(m5, direction);

    if (ob && nearH4Context(ob, context)) {
      add(
        direction,
        "M5 ORDER BLOCK RETEST",
        ob
      );
    }

    const fvg = findFVG(m5, direction);

    if (fvg && nearH4Context(fvg, context)) {
      add(
        direction,
        "M5 FVG RETEST",
        fvg
      );
    }
  }

  return signals;
}

// ==========================================
// 13. STRATEGY 2 - SCALPING
// ==========================================

function detectScalping(h4, m5, context) {
  const current = m5[0];
  const confirmation = candleType(current);
  const signals = [];

  for (const direction of ["BUY", "SELL"]) {
    const validConfirmation = direction === "BUY"
      ? confirmation.bullish
      : confirmation.bearish;

    if (!validConfirmation) continue;

    const ob = findOrderBlock(m5, direction);

    if (!ob || !nearH4Context(ob, context)) {
      continue;
    }

    const sl = direction === "BUY"
      ? Math.min(current.low, ob.low) - SL_BUFFER
      : Math.max(current.high, ob.high) + SL_BUFFER;

    const signal = buildSignal({
      direction,
      strategy: "SCALPING",
      setup: "M5 UNTESTED ORDER BLOCK",
      candle: current,
      h4,
      m5,
      sl,
      targetMode: "SCALPING"
    });

    if (signal) signals.push(signal);
  }

  return signals;
}

// ==========================================
// 14. STRATEGY 3 - H4 LIQUIDITY SWEEP
// ==========================================

function detectLiquiditySweep(h4, m5) {
  const current = m5[0];
  const first = m5[1];

  if (!current || !first) return [];

  const levels = getH4SweepLevels(h4);
  const signals = [];

  const firstTime = Date.parse(first.openTime);

  if (!Number.isFinite(firstTime)) {
    return signals;
  }

  for (const level of levels) {
    // H4 level must already be established
    // before the first M5 breakout candle.
    if (firstTime < level.availableAt) continue;

    // SELL:
    // Candle 1 closes above H4 High.
    // Candle 2 closes back below H4 High.
    if (
      level.side === "HIGH" &&
      first.close > level.price &&
      current.close < level.price
    ) {
      const sweepWick = Math.max(
        first.high,
        current.high
      );

      const sl = sweepWick + SL_BUFFER;

      const signal = buildSignal({
        direction: "SELL",
        strategy: "LIQUIDITY SWEEP",
        setup: "H4 HIGH SWEEP - TWO CANDLE",
        candle: current,
        h4,
        m5,
        sl,
        targetMode: "SWEEP"
      });

      if (signal) signals.push(signal);
    }

    // BUY:
    // Candle 1 closes below H4 Low.
    // Candle 2 closes back above H4 Low.
    if (
      level.side === "LOW" &&
      first.close < level.price &&
      current.close > level.price
    ) {
      const sweepWick = Math.min(
        first.low,
        current.low
      );

      const sl = sweepWick - SL_BUFFER;

      const signal = buildSignal({
        direction: "BUY",
        strategy: "LIQUIDITY SWEEP",
        setup: "H4 LOW SWEEP - TWO CANDLE",
        candle: current,
        h4,
        m5,
        sl,
        targetMode: "SWEEP"
      });

      if (signal) signals.push(signal);
    }
  }

  return signals;
}

// ==========================================
// 15. DUPLICATE SIGNAL FILTER
// ==========================================

function removeDuplicateSignals(signals) {
  const seen = new Set();

  return signals.filter(signal => {
    const key = [
      signal.id,
      signal.strategy,
      signal.direction,
      signal.setup
    ].join(":");

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

// ==========================================
// 16. MAIN ENGINE - ALL THREE STRATEGIES
// ==========================================

export function generateSignals(
  h4Bars = [],
  m5Bars = [],
  options = {}
) {
  const h4 = completedCandles(h4Bars);
  const m5 = completedCandles(m5Bars);

  if (h4.length < 5 || m5.length < 40) {
    return {
      signals: [],
      strategies: {
        intraday: [],
        scalping: [],
        liquiditySweep: []
      },
      message: "Not enough completed candles"
    };
  }

  // This pause works only if a connected news feed
  // passes options.newsBlackout = true.
  if (options.newsBlackout === true) {
    return {
      signals: [],
      strategies: {
        intraday: [],
        scalping: [],
        liquiditySweep: []
      },
      message: "High-impact USD news filter: trading paused"
    };
  }

  // Newest completed M5 candle and its previous candle.
  const current = {
    ...m5[0],
    previous: m5[1]
  };

  m5[0] = current;

  const context = getH4Context(h4);

  // Run all three strategies.
  const intradaySignals = detectIntraday(
    h4,
    m5,
    context
  );

  const scalpingSignals = detectScalping(
    h4,
    m5,
    context
  );

  const sweepSignals = detectLiquiditySweep(
    h4,
    m5
  );

  const allSignals = removeDuplicateSignals([
    ...intradaySignals,
    ...scalpingSignals,
    ...sweepSignals
  ]);

  return {
    signals: allSignals,

    strategies: {
      intraday: allSignals.filter(
        s => s.strategy === "INTRADAY"
      ),

      scalping: allSignals.filter(
        s => s.strategy === "SCALPING"
      ),

      liquiditySweep: allSignals.filter(
        s => s.strategy === "LIQUIDITY SWEEP"
      )
    },

    message: allSignals.length
      ? "Confirmed M5 setup found"
      : "No valid setup found",

    rules: {
      instrument: "XAUUSD",

      contextTimeframe: "H4",
      entryTimeframe: "M5",

      maxSLDistance: MAX_SL_DISTANCE,
      minimumRR: MIN_RR,
      preferredRR: PREFERRED_RR,

      slBuffer: SL_BUFFER,

      strategies: [
        "INTRADAY",
        "SCALPING",
        "LIQUIDITY SWEEP"
      ],

      intradayTP1: "H4 CANDLE HIGH/LOW",
      intradayTP2: "NEXT H4 LEVEL / ZONE",
      intradayTP3: "OPPOSITE INTRADAY SIGNAL - NOT YET TRACKED",

      scalpingTP1: "NEXT M5 SWING HIGH/LOW",
      scalpingTP2: "NEXT M5 SWING LEVEL",

      sweepConfirmation: "TWO COMPLETED M5 CANDLES",
      sweepSL: "BEYOND SWEEP WICK",
      sweepTP1: "NEAREST M5 SUPPORT/RESISTANCE",
      sweepTP2: "H4 OPPOSITE LEVEL / NEXT ZONE",

      confirmationCandles: [
        "ENGULFING",
        "PIN BAR",
        "REJECTION"
      ],

      duplicateFilter: "WITHIN CURRENT RESULT",
      newsFilterConnected: false,
      chartLevelsDisplayed: false
    }
  };
}
