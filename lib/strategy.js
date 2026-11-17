const MAX_SL_DISTANCE = 12;
const MIN_RR = 2;
const PREFERRED_RR = 3;
const SL_BUFFER = 0.20;
const TOP_TOLERANCE = 1.50;
const LOOKBACK = 80;
const M5_INTERVAL_MS = 5 * 60 * 1000;
const H4_INTERVAL_MS = 4 * 60 * 60 * 1000;

// 1. DIAGNOSTICS
function createDiagnostics() {
  const make = () => ({
    checks: 0,
    setupsFound: 0,
    signalsCreated: 0,
    rejectedCount: 0,
    reasons: []
  });
  return {
    intraday: make(),
    scalping: make(),
    liquiditySweep: make()
  };
}

function diagCheck(d) {
  if (d) d.checks++;
}
function diagSetup(d) {
  if (d) d.setupsFound++;
}
function diagSignal(d) {
  if (d) d.signalsCreated++;
}
function diagReject(d, reason) {
  if (!d) return;
  d.rejectedCount++;
  if (d.reasons.length < 15) d.reasons.push(reason);
}
function diagnosticSummary(diagnostics) {
  for (const item of Object.values(diagnostics)) {
    if (item.reasons.length >= 15) {
      item.reasons.push("Additional rejection reasons omitted");
    }
  }
  return diagnostics;
}

// 2. CANDLE DATA
function completedCandles(bars = []) {
  return bars
    .filter(c =>
      c &&
      c.isOpen !== true &&
      c.open != null &&
      c.high != null &&
      c.low != null &&
      c.close != null &&
      [c.open, c.high, c.low, c.close].every(v =>
        Number.isFinite(Number(v))
      ) &&
      Number.isFinite(Date.parse(c.openTime)) &&
      Number(c.high) >= Number(c.low) &&
      Number(c.high) >= Number(c.open) &&
      Number(c.high) >= Number(c.close) &&
      Number(c.low) <= Number(c.open) &&
      Number(c.low) <= Number(c.close)
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
function candleBody(c) {
  return Math.abs(c.close - c.open);
}
function candleWicks(c) {
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  return upper + lower;
}

// 3. M5 CONFIRMATION CANDLES
function candleType(c) {
  const empty = {
    bullish: false,
    bearish: false,
    engulfing: false,
    pinBar: false,
    rejection: false,
    bullishEngulfing: false,
    bearishEngulfing: false,
    bullishPinBar: false,
    bearishPinBar: false,
    bullishRejection: false,
    bearishRejection: false,
    confirmationTypes: []
  };

  if (
    !c ||
    ![c.open, c.high, c.low, c.close].every(Number.isFinite)
  ) return empty;

  const range = c.high - c.low;
  if (range <= 0) return empty;

  const body = candleBody(c);
  const upper = Math.max(0, c.high - Math.max(c.open, c.close));
  const lower = Math.max(0, Math.min(c.open, c.close) - c.low);
  const bullish = c.close > c.open;
  const bearish = c.close < c.open;
  const previous = c.previous;

  const bullishEngulfing =
    bullish &&
    previous &&
    previous.close < previous.open &&
    c.open <= previous.close &&
    c.close >= previous.open;

  const bearishEngulfing =
    bearish &&
    previous &&
    previous.close > previous.open &&
    c.open >= previous.close &&
    c.close <= previous.open;

  const closeLocation = (c.close - c.low) / range;

  const bullishPinBar =
    bullish &&
    lower >= Math.max(body * 1.8, range * 0.38) &&
    upper <= range * 0.25 &&
    closeLocation >= 0.60;

  const bearishPinBar =
    bearish &&
    upper >= Math.max(body * 1.8, range * 0.38) &&
    lower <= range * 0.25 &&
    closeLocation <= 0.40;

  const bullishRejection =
    bullish &&
    lower >= range * 0.40 &&
    lower >= upper * 1.5 &&
    closeLocation >= 0.60;

  const bearishRejection =
    bearish &&
    upper >= range * 0.40 &&
    upper >= lower * 1.5 &&
    closeLocation <= 0.40;

  const confirmationTypes = [];
  if (bullishEngulfing) confirmationTypes.push("BULLISH ENGULFING");
  if (bearishEngulfing) confirmationTypes.push("BEARISH ENGULFING");
  if (bullishPinBar) confirmationTypes.push("BULLISH PIN BAR");
  if (bearishPinBar) confirmationTypes.push("BEARISH PIN BAR");
  if (bullishRejection) confirmationTypes.push("BULLISH REJECTION");
  if (bearishRejection) confirmationTypes.push("BEARISH REJECTION");

  return {
    bullish: bullishEngulfing || bullishPinBar || bullishRejection,
    bearish: bearishEngulfing || bearishPinBar || bearishRejection,
    engulfing: bullishEngulfing || bearishEngulfing,
    pinBar: bullishPinBar || bearishPinBar,
    rejection: bullishRejection || bearishRejection,
    bullishEngulfing,
    bearishEngulfing,
    bullishPinBar,
    bearishPinBar,
    bullishRejection,
    bearishRejection,
    confirmationTypes
  };
}

// 4. CONFIRMED SWING HIGH / LOW
function findPivots(candles, limit = LOOKBACK) {
  const highs = [];
  const lows = [];
  const sample = candles.slice(0, limit);

  for (let i = 1; i < sample.length - 1; i++) {
    const c = sample[i];
    const newer = sample[i - 1];
    const older = sample[i + 1];

    if (c.high >= newer.high && c.high >= older.high) {
      highs.push({ price: c.high, time: c.openTime, index: i });
    }
    if (c.low <= newer.low && c.low <= older.low) {
      lows.push({ price: c.low, time: c.openTime, index: i });
    }
  }
  return { highs, lows };
}

// 5. DOUBLE / TRIPLE TOP & BOTTOM
function findPattern(candles, direction) {
  const pivots = findPivots(candles, 40);
  const points = direction === "SELL" ? pivots.highs : pivots.lows;
  if (points.length < 2) return null;

  const newest = points[0];
  const matches = points.slice(1).filter(p =>
    p.index - newest.index >= 2 &&
    p.index - newest.index <= 30 &&
    Math.abs(p.price - newest.price) <= TOP_TOLERANCE
  );
  if (!matches.length) return null;

  const selected = [newest, ...matches.slice(0, 2)];
  const prices = selected.map(p => p.price);
  const patternHigh = Math.max(...prices);
  const patternLow = Math.min(...prices);
  const patternPrice = (patternHigh + patternLow) / 2;
  const current = candles[0];

  const retestingPattern = direction === "SELL"
    ? current.high >= patternLow - TOP_TOLERANCE &&
      current.high <= patternHigh + TOP_TOLERANCE
    : current.low <= patternHigh + TOP_TOLERANCE &&
      current.low >= patternLow - TOP_TOLERANCE;

  if (!retestingPattern) return null;

  return {
    type: selected.length >= 3 ? "TRIPLE" : "DOUBLE",
    price: patternPrice,
    zone: {
      low: patternLow - TOP_TOLERANCE,
      high: patternHigh + TOP_TOLERANCE
    }
  };
}

// 6. COMPACT BASE CANDLE FILTER
function compactBaseCandle(base, impulse) {
  return (
    candleBody(base) < candleBody(impulse) &&
    candleWicks(base) < candleWicks(impulse)
  );
}

// 7. UNTESTED ORDER BLOCK
function findOrderBlock(candles, direction, useCompactFilter = false) {
  const current = candles[0];

  for (let i = 2; i < Math.min(candles.length - 1, LOOKBACK); i++) {
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
    if (useCompactFilter && !compactBaseCandle(base, impulse)) continue;

    const zone = direction === "BUY"
      ? { low: base.low, high: base.open }
      : { low: base.open, high: base.high };

    if (zone.low >= zone.high) continue;

    const alreadyTested = candles
      .slice(1, i - 1)
      .some(c => overlaps(c, zone));

    if (alreadyTested) continue;
    if (overlaps(current, zone)) {
      return {
        ...zone,
        type: direction + " OB",
        formationTime: base.openTime
      };
    }
  }
  return null;
}

// 8. UNTESTED FAIR VALUE GAP
function findFVG(candles, direction) {
  const current = candles[0];

  for (let i = 2; i < Math.min(candles.length - 2, LOOKBACK); i++) {
    const newer = candles[i - 1];
    const older = candles[i + 1];
    let zone = null;

    if (direction === "BUY" && newer.low > older.high) {
      zone = {
        low: older.high,
        high: newer.low,
        type: "BULLISH FVG"
      };
    }
    if (direction === "SELL" && newer.high < older.low) {
      zone = {
        low: newer.high,
        high: older.low,
        type: "BEARISH FVG"
      };
    }

    if (!zone || zone.low >= zone.high) continue;

    const alreadyTested = candles
      .slice(1, i - 1)
      .some(c => overlaps(c, zone));

    if (!alreadyTested && overlaps(current, zone)) return zone;
  }
  return null;
}

// 9. H4 ORDER BLOCKS & FVG ZONES
function getH4Zones(h4) {
  const orderBlocks = [];
  const fvgs = [];

  for (let i = 2; i < Math.min(h4.length - 1, 40); i++) {
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

// 10. H4 CONTEXT AND LEVELS
function getH4Context(h4) {
  const levels = [];
  h4.slice(0, 30).forEach(c => {
    levels.push(c.high, c.low, c.open, c.close);
  });

  const pivots = findPivots(h4, 30);
  pivots.highs.forEach(p => levels.push(p.price));
  pivots.lows.forEach(p => levels.push(p.price));

  const zones = getH4Zones(h4);
  zones.orderBlocks.forEach(z => levels.push(z.low, z.high));
  zones.fvgs.forEach(z => levels.push(z.low, z.high));

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
  const allZones = [...context.orderBlocks, ...context.fvgs];
  const nearZone = allZones.some(h4Zone =>
    overlaps(zone, h4Zone) ||
    Math.abs(price - middle(h4Zone)) <= TOP_TOLERANCE
  );
  return nearLevel || nearZone;
}

// 11. H4 LIQUIDITY SWEEP LEVELS
function getH4SweepLevels(h4) {
  const levels = [];
  if (!h4.length) return levels;

  function h4CloseTime(candle) {
    const time = Date.parse(candle.openTime);
    return Number.isFinite(time) ? time + H4_INTERVAL_MS : null;
  }

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

  for (let i = 1; i < Math.min(h4.length - 1, 30); i++) {
    const candle = h4[i];
    const newer = h4[i - 1];
    const older = h4[i + 1];
    const availableAt = h4CloseTime(newer);
    if (availableAt === null) continue;

    if (candle.high >= newer.high && candle.high >= older.high) {
      levels.push({
        price: candle.high,
        side: "HIGH",
        availableAt
      });
    }
    if (candle.low <= newer.low && candle.low <= older.low) {
      levels.push({
        price: candle.low,
        side: "LOW",
        availableAt
      });
    }
  }

  return levels.filter((level, index, array) =>
    array.findIndex(item =>
      item.side === level.side && item.price === level.price
    ) === index
  );
}

// 12. TARGET CALCULATION
function selectTargets(candidates, entry, risk, direction) {
  const valid = uniqueNumbers(candidates)
    .filter(price => {
      const distance = direction === "BUY"
        ? price - entry
        : entry - price;
      return distance > 0 && distance / risk >= MIN_RR;
    })
    .sort((a, b) => direction === "BUY" ? a - b : b - a);

  return {
    tp1: valid[0] ?? null,
    tp2: valid[1] ?? null
  };
}

function intradayTargets(h4, entry, risk, direction) {
  const candleLevels = [];
  h4.slice(0, 30).forEach(c => {
    if (direction === "BUY" && c.high > entry) candleLevels.push(c.high);
    if (direction === "SELL" && c.low < entry) candleLevels.push(c.low);
  });

  const first = selectTargets(candleLevels, entry, risk, direction);
  if (first.tp1 === null) return { tp1: null, tp2: null };

  const context = getH4Context(h4);
  const allLevels = [
    ...context.levels,
    ...context.orderBlocks.flatMap(z => [z.low, z.high]),
    ...context.fvgs.flatMap(z => [z.low, z.high])
  ];

  const secondCandidates = allLevels.filter(price =>
    direction === "BUY" ? price > first.tp1 : price < first.tp1
  );
  const second = selectTargets(secondCandidates, entry, risk, direction);

  return { tp1: first.tp1, tp2: second.tp1 };
}

function m5Targets(m5, entry, risk, direction) {
  const pivots = findPivots(m5, 60);
  const candidates = direction === "BUY"
    ? pivots.highs.map(p => p.price)
    : pivots.lows.map(p => p.price);
  return selectTargets(candidates, entry, risk, direction);
}

function sweepTargets(h4, m5, entry, risk, direction) {
  const first = m5Targets(m5, entry, risk, direction);
  if (first.tp1 === null) return { tp1: null, tp2: null };

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
    direction === "SELL" ? price < first.tp1 : price > first.tp1
  );
  const second = selectTargets(beyondTP1, entry, risk, direction);
  return { tp1: first.tp1, tp2: second.tp1 };
}

// 13. COMMON SIGNAL BUILDER
function buildSignal({
  direction,
  strategy,
  setup,
  candle,
  h4,
  m5,
  sl,
  targetMode,
  diagnostic
}) {
  const reject = reason => {
    diagReject(diagnostic, reason);
    return null;
  };

  const entry = candle.close;

  if (
    (direction === "BUY" && sl >= entry) ||
    (direction === "SELL" && sl <= entry)
  ) {
    return reject("SL is on the wrong side of entry");
  }

  const distance = Math.abs(entry - sl);
  if (!Number.isFinite(distance) || distance <= 0) {
    return reject("Invalid SL distance");
  }
  if (distance > MAX_SL_DISTANCE) {
    return reject("SL exceeds maximum $12.00 distance");
  }

  // INTRADAY and SCALPING both use the user's H4 target rules.
  let targets;
  if (targetMode === "INTRADAY" || targetMode === "SCALPING") {
    targets = intradayTargets(h4, entry, distance, direction);
  } else if (targetMode === "SWEEP") {
    targets = sweepTargets(h4, m5, entry, distance, direction);
  } else {
    targets = m5Targets(m5, entry, distance, direction);
  }

  if (targets.tp1 === null) {
    return reject("TP1 not found or does not meet RR 1:2");
  }
  if (targets.tp2 === null) {
    return reject("TP2 not found or does not meet RR 1:2");
  }

  const reward1 = Math.abs(targets.tp1 - entry);
  const reward2 = Math.abs(targets.tp2 - entry);
  const rr1 = reward1 / distance;
  const rr2 = reward2 / distance;

  if (rr1 < MIN_RR) return reject("TP1 reward-risk is below 1:2");
  if (rr2 < MIN_RR) return reject("TP2 reward-risk is below 1:2");

  return {
    id: [candle.openTime, strategy, direction, setup].join("_"),
    strategy,
    direction,
    setup,
    entry: Number(entry.toFixed(3)),
    sl: Number(sl.toFixed(3)),
    tp1: Number(targets.tp1.toFixed(3)),
    tp2: Number(targets.tp2.toFixed(3)),
    tp3: null,
    riskDistance: Number(distance.toFixed(2)),
    rewardRisk: Number(rr1.toFixed(2)),
    tp2RewardRisk: Number(rr2.toFixed(2)),
    confirmation: "Completed M5 candle",
    confirmationTypes: candleType(candle).confirmationTypes,
    signalTime: candle.openTime,
    status: "SIGNAL"
  };
}

// 14. STRATEGY 1 - INTRADAY
function detectIntraday(h4, m5, context, diagnostics) {
  const d = diagnostics.intraday;
  const current = m5[0];
  const confirmation = candleType(current);
  const signals = [];

  function add(direction, setup, zone = null) {
    const sl = direction === "BUY"
      ? Math.min(current.low, zone ? zone.low : current.low) - SL_BUFFER
      : Math.max(current.high, zone ? zone.high : current.high) + SL_BUFFER;

    const signal = buildSignal({
      direction,
      strategy: "INTRADAY",
      setup,
      candle: current,
      h4,
      m5,
      sl,
      targetMode: "INTRADAY",
      diagnostic: d
    });

    if (signal) {
      signals.push(signal);
      diagSignal(d);
    }
  }

  diagCheck(d);
  const top = findPattern(m5, "SELL");
  if (top) {
    diagSetup(d);
    if (!confirmation.bearish) {
      diagReject(d, "Top pattern found but bearish M5 confirmation missing");
    } else if (!nearH4Context(top.zone, context)) {
      diagReject(d, "Top pattern found but not near H4 context");
    } else {
      add("SELL", top.type + " TOP", top.zone);
    }
  } else {
    diagReject(d, "No double/triple top retest found");
  }

  diagCheck(d);
  const bottom = findPattern(m5, "BUY");
  if (bottom) {
    diagSetup(d);
    if (!confirmation.bullish) {
      diagReject(d, "Bottom pattern found but bullish M5 confirmation missing");
    } else if (!nearH4Context(bottom.zone, context)) {
      diagReject(d, "Bottom pattern found but not near H4 context");
    } else {
      add("BUY", bottom.type + " BOTTOM", bottom.zone);
    }
  } else {
    diagReject(d, "No double/triple bottom retest found");
  }

  for (const direction of ["BUY", "SELL"]) {
    const validConfirmation = direction === "BUY"
      ? confirmation.bullish
      : confirmation.bearish;

    diagCheck(d);
    const ob = findOrderBlock(m5, direction);
    if (!ob) {
      diagReject(d, direction + " M5 untested OB retest not found");
    } else {
      diagSetup(d);
      if (!validConfirmation) {
        diagReject(d, direction + " OB found but M5 confirmation missing");
      } else if (!nearH4Context(ob, context)) {
        diagReject(d, direction + " OB found but not near H4 context");
      } else {
        add(direction, "M5 ORDER BLOCK RETEST", ob);
      }
    }

    diagCheck(d);
    const fvg = findFVG(m5, direction);
    if (!fvg) {
      diagReject(d, direction + " M5 untested FVG retest not found");
    } else {
      diagSetup(d);
      if (!validConfirmation) {
        diagReject(d, direction + " FVG found but M5 confirmation missing");
      } else if (!nearH4Context(fvg, context)) {
        diagReject(d, direction + " FVG found but not near H4 context");
      } else {
        add(direction, "M5 FVG RETEST", fvg);
      }
    }
  }
  return signals;
}

// 15. STRATEGY 2 - SCALPING
function detectScalping(h4, m5, context, diagnostics) {
  const d = diagnostics.scalping;
  const current = m5[0];
  const confirmation = candleType(current);
  const signals = [];

  for (const direction of ["BUY", "SELL"]) {
    const validConfirmation = direction === "BUY"
      ? confirmation.bullish
      : confirmation.bearish;

    diagCheck(d);
    const ob = findOrderBlock(m5, direction, true);
    if (!ob) {
      diagReject(d, direction + " compact-base untested OB not found");
    } else {
      diagSetup(d);
      if (!validConfirmation) {
        diagReject(d, direction + " OB found but M5 confirmation missing");
      } else if (!nearH4Context(ob, context)) {
        diagReject(d, direction + " OB found but not near H4 context");
      } else {
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
          targetMode: "SCALPING",
          diagnostic: d
        });
        if (signal) {
          signals.push(signal);
          diagSignal(d);
        }
      }
    }

    diagCheck(d);
    const fvg = findFVG(m5, direction);
    if (!fvg) {
      diagReject(d, direction + " untested FVG retest not found");
    } else {
      diagSetup(d);
      if (!validConfirmation) {
        diagReject(d, direction + " FVG found but M5 confirmation missing");
      } else if (!nearH4Context(fvg, context)) {
        diagReject(d, direction + " FVG found but not near H4 context");
      } else {
        const sl = direction === "BUY"
          ? Math.min(current.low, fvg.low) - SL_BUFFER
          : Math.max(current.high, fvg.high) + SL_BUFFER;

        const signal = buildSignal({
          direction,
          strategy: "SCALPING",
          setup: "M5 UNTESTED FVG RETEST",
          candle: current,
          h4,
          m5,
          sl,
          targetMode: "SCALPING",
          diagnostic: d
        });
        if (signal) {
          signals.push(signal);
          diagSignal(d);
        }
      }
    }
  }
  return signals;
}

// 16. STRATEGY 3 - H4 LIQUIDITY SWEEP
function detectLiquiditySweep(h4, m5, diagnostics) {
  const d = diagnostics.liquiditySweep;
  const current = m5[0];
  const first = m5[1];

  if (!current || !first) {
    diagReject(d, "Two completed M5 candles are not available");
    return [];
  }

  const signals = [];
  const levels = getH4SweepLevels(h4);
  if (!levels.length) {
    diagReject(d, "No eligible completed H4 sweep levels found");
    return signals;
  }

  const firstTime = Date.parse(first.openTime);
  const currentTime = Date.parse(current.openTime);
  if (!Number.isFinite(firstTime) || !Number.isFinite(currentTime)) {
    diagReject(d, "Invalid M5 candle timestamps");
    return signals;
  }
  if (currentTime - firstTime !== M5_INTERVAL_MS) {
    diagReject(d, "Sweep candles are not consecutive M5 candles");
    return signals;
  }

  let eligibleLevels = 0;
  let matchedSetups = 0;

  for (const level of levels) {
    if (firstTime < level.availableAt) continue;
    eligibleLevels++;
    diagCheck(d);

    if (
      level.side === "HIGH" &&
      first.close > level.price &&
      current.close < level.price
    ) {
      matchedSetups++;
      diagSetup(d);
      const sl = Math.max(first.high, current.high) + SL_BUFFER;
      const signal = buildSignal({
        direction: "SELL",
        strategy: "LIQUIDITY SWEEP",
        setup: "H4 HIGH SWEEP - TWO CANDLE",
        candle: current,
        h4,
        m5,
        sl,
        targetMode: "SWEEP",
        diagnostic: d
      });
      if (signal) {
        signals.push(signal);
        diagSignal(d);
      }
    }

    if (
      level.side === "LOW" &&
      first.close < level.price &&
      current.close > level.price
    ) {
      matchedSetups++;
      diagSetup(d);
      const sl = Math.min(first.low, current.low) - SL_BUFFER;
      const signal = buildSignal({
        direction: "BUY",
        strategy: "LIQUIDITY SWEEP",
        setup: "H4 LOW SWEEP - TWO CANDLE",
        candle: current,
        h4,
        m5,
        sl,
        targetMode: "SWEEP",
        diagnostic: d
      });
      if (signal) {
        signals.push(signal);
        diagSignal(d);
      }
    }
  }

  if (!eligibleLevels) {
    diagReject(d, "No H4 sweep level was available before first M5 candle");
  } else if (!matchedSetups) {
    diagReject(d, "No two-candle close-and-return sweep pattern found");
  }
  return signals;
}

// 17. DUPLICATE SIGNAL FILTER
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

// 18. OPTIONAL TP3 LINKING
function attachTP3(signals) {
  const intraday = signals.filter(s => s.strategy === "INTRADAY");
  return signals.map(signal => {
    if (signal.strategy !== "INTRADAY" || signal.tp2 == null) {
      return signal;
    }

    const opposite = intraday.find(other =>
      other.direction !== signal.direction &&
      (
        signal.direction === "BUY"
          ? other.entry > signal.tp2
          : other.entry < signal.tp2
      )
    );
    if (!opposite) return signal;
    return { ...signal, tp3: opposite.entry };
  });
}

// 19. RULES
function strategyRules() {
  return {
    instrument: "XAUUSD",
    contextTimeframe: "H4",
    entryTimeframe: "M5",
    maxSLDistance: MAX_SL_DISTANCE,
    minimumRR: MIN_RR,
    preferredRR: PREFERRED_RR,
    slBuffer: SL_BUFFER,
    strategies: ["INTRADAY", "SCALPING", "LIQUIDITY SWEEP"],

    intradayTP1: "NEXT VALID H4 CANDLE HIGH/LOW",
    intradayTP2: "NEXT H4 LEVEL / ZONE",
    intradayTP3: "OPPOSITE INTRADAY SIGNAL WHEN AVAILABLE",

    scalpingSetups: [
      "M5 UNTESTED ORDER BLOCK",
      "M5 UNTESTED FVG RETEST"
    ],
    scalpingBaseFilter:
      "BASE BODY AND WICKS SMALLER THAN IMPULSE CANDLE",
    scalpingTP1: "NEXT VALID H4 CANDLE HIGH/LOW",
    scalpingTP2: "NEXT H4 LEVEL / ZONE AFTER TP1",

    sweepConfirmation: "TWO CONSECUTIVE COMPLETED M5 CANDLES",
    sweepSL: "BEYOND BOTH SWEEP CANDLES WICK",
    sweepTP1: "NEAREST VALID M5 SUPPORT/RESISTANCE",
    sweepTP2: "NEXT H4 OPPOSITE LEVEL / ZONE",

    confirmationCandles: ["ENGULFING", "PIN BAR", "REJECTION"],
    confirmationQuality:
      "DIRECTIONAL CLOSE + DOMINANT REJECTION WICK + COMPLETED M5 CANDLE",
    tp1AndTP2Required: true,
    duplicateFilter: "WITHIN CURRENT RESULT",
    newsFilterConnected: false,
    chartLevelsDisplayed: false
  };
}

// 20. MAIN ENGINE - ALL THREE STRATEGIES
export function generateSignals(h4Bars = [], m5Bars = [], options = {}) {
  const h4 = completedCandles(h4Bars);
  const m5 = completedCandles(m5Bars);

  const emptyStrategies = {
    intraday: [],
    scalping: [],
    liquiditySweep: []
  };
  const rules = strategyRules();
  const diagnostics = createDiagnostics();

  if (h4.length < 5 || m5.length < 40) {
    return {
      signals: [],
      strategies: emptyStrategies,
      message: "Not enough completed candles",
      diagnostics: diagnosticSummary(diagnostics),
      dataChecks: {
        completedH4Candles: h4.length,
        completedM5Candles: m5.length,
        requiredH4Candles: 5,
        requiredM5Candles: 40
      },
      rules
    };
  }

  if (options.newsBlackout === true) {
    return {
      signals: [],
      strategies: emptyStrategies,
      message: "High-impact USD news filter: trading paused",
      diagnostics: diagnosticSummary(diagnostics),
      rules
    };
  }

  // Attach the previous completed M5 candle for engulfing checks.
  const current = { ...m5[0], previous: m5[1] };
  m5[0] = current;

  const context = getH4Context(h4);
  const intradaySignals = detectIntraday(h4, m5, context, diagnostics);
  const scalpingSignals = detectScalping(h4, m5, context, diagnostics);
  const sweepSignals = detectLiquiditySweep(h4, m5, diagnostics);

  let allSignals = removeDuplicateSignals([
    ...intradaySignals,
    ...scalpingSignals,
    ...sweepSignals
  ]);
  allSignals = attachTP3(allSignals);

  return {
    signals: allSignals,
    strategies: {
      intraday: allSignals.filter(s => s.strategy === "INTRADAY"),
      scalping: allSignals.filter(s => s.strategy === "SCALPING"),
      liquiditySweep: allSignals.filter(s => s.strategy === "LIQUIDITY SWEEP")
    },
    message: allSignals.length
      ? "Confirmed M5 setup found"
      : "No valid setup found",
    diagnostics: diagnosticSummary(diagnostics),
    dataChecks: {
      completedH4Candles: h4.length,
      completedM5Candles: m5.length,
      currentM5CandleTime: current.openTime
    },
    rules
  };
}
