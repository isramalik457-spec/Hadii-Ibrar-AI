
const MAX_ACTIVE_SIGNALS = 100;

function send(res, status, data) {
  return res.status(status).json(data);
}

async function redisCommand(command, key, value) {
  const base = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  if (!base || !token) {
    throw new Error("Redis environment variables missing");
  }

  const path = value === undefined
    ? `/${command}/${encodeURIComponent(key)}`
    : `/${command}/${encodeURIComponent(key)}/${encodeURIComponent(value)}`;

  const response = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error("Redis request failed");
  }

  const result = await response.json();
  return result.result;
}

async function getJSON(key, fallback) {
  const value = await redisCommand("get", key);
  if (!value) return fallback;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function saveJSON(key, value) {
  await redisCommand("set", key, JSON.stringify(value));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return send(res, 405, { success: false, message: "POST only" });
  }

  const secret = process.env.MONITOR_SECRET;
  const authorization = req.headers.authorization || "";

  if (!secret || authorization !== `Bearer ${secret}`) {
    return send(res, 401, { success: false, message: "Unauthorized" });
  }

  try {
    const origin = process.env.APP_URL
      ? process.env.APP_URL
      : `https://${req.headers.host}`;

    const response = await fetch(`${origin}/api/gold`, {
      headers: { Accept: "application/json" },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("Gold API unavailable");
    }

    const gold = await response.json();

    if (
      !gold.success ||
      !gold.canGenerateSignals ||
      gold.dataStatus !== "LIVE"
    ) {
      return send(res, 200, {
        success: true,
        monitored: false,
        reason: gold.signalBlockReason || gold.message || "Live data unavailable"
      });
    }

    const signals = Array.isArray(gold.strategy?.signals)
      ? gold.strategy.signals
      : [];

    let activeIds = await getJSON("hadii:active-signals", []);
    const events = [];
    let newCount = 0;

    for (const signal of signals) {
      if (!signal.id || !["BUY", "SELL"].includes(signal.direction)) continue;

      const key = `hadii:signal:${signal.id}`;
      const existing = await getJSON(key, null);

      if (!existing) {
        const record = {
          ...signal,
          status: "ACTIVE",
          tp1Hit: false,
          createdAt: new Date().toISOString()
        };

        await saveJSON(key, record);
        activeIds.push(signal.id);
        newCount++;

        events.push({
          type: "NEW_SIGNAL",
          signalId: signal.id,
          direction: signal.direction,
          entry: signal.entry,
          sl: signal.sl,
          tp1: signal.tp1,
          tp2: signal.tp2
        });
      }
    }

    const bid = Number(gold.quote?.bid);
    const ask = Number(gold.quote?.ask);

    for (const id of [...new Set(activeIds)]) {
      const key = `hadii:signal:${id}`;
      const record = await getJSON(key, null);

      if (!record || record.status === "CLOSED") continue;

      const price = record.direction === "BUY" ? bid : ask;
      if (!Number.isFinite(price)) continue;

      const hitSL = record.direction === "BUY"
        ? price <= Number(record.sl)
        : price >= Number(record.sl);

      const hitTP1 = record.direction === "BUY"
        ? price >= Number(record.tp1)
        : price <= Number(record.tp1);

      const hitTP2 = record.direction === "BUY"
        ? price >= Number(record.tp2)
        : price <= Number(record.tp2);

      if (hitSL) {
        record.status = "CLOSED";
        record.closedAt = new Date().toISOString();
        events.push({ type: "SL_HIT", signalId: id });
      } else if (hitTP2) {
        if (!record.tp1Hit) {
          record.tp1Hit = true;
          events.push({ type: "TP1_HIT", signalId: id });
        }

        record.status = "CLOSED";
        record.closedAt = new Date().toISOString();
        events.push({ type: "TP2_HIT", signalId: id });
      } else if (hitTP1 && !record.tp1Hit) {
        record.tp1Hit = true;
        events.push({ type: "TP1_HIT", signalId: id });
      }

      await saveJSON(key, record);
    }

    activeIds = [...new Set(activeIds)].slice(-MAX_ACTIVE_SIGNALS);
    await saveJSON("hadii:active-signals", activeIds);

    return send(res, 200, {
      success: true,
      monitored: true,
      newSignals: newCount,
      events,
      checkedAt: new Date().toISOString()
    });

  } catch (error) {
    return send(res, 500, {
      success: false,
      message: error.message
    });
  }
}
