
import { sendPushNotification } from "../lib/push.js";

const MAX_ACTIVE_SIGNALS = 100;
const PENDING_KEY = "hadii:push:pending";

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

function makeEvent(type, signalId, details = {}) {
  return {
    id: `${type}:${signalId}`,
    type,
    signalId,
    ...details,
    createdAt: new Date().toISOString()
  };
}

function notificationFor(event, record) {
  const direction = record?.direction || event.direction || "";

  if (event.type === "NEW_SIGNAL") {
    return {
      title: `HADII AI QUANT: ${direction} SIGNAL`,
      body: `XAUUSD ${direction} | Entry: ${event.entry} | SL: ${event.sl} | TP1: ${event.tp1} | TP2: ${event.tp2}`,
      tag: event.id,
      url: "/"
    };
  }

  const messages = {
    TP1_HIT: {
      title: "XAUUSD TP1 HIT 🎯",
      body: `${direction} signal reached Take Profit 1.`
    },
    TP2_HIT: {
      title: "XAUUSD TP2 HIT 🏆",
      body: `${direction} signal reached Take Profit 2.`
    },
    SL_HIT: {
      title: "XAUUSD STOP LOSS HIT",
      body: `${direction} signal reached Stop Loss.`
    }
  };

  const message = messages[event.type];
  if (!message) return null;

  return {
    ...message,
    tag: event.id,
    url: "/"
  };
}

async function deliverPendingEvents(pending) {
  const ids = await redisCommand(
    "smembers",
    "hadii:push:subscription-ids"
  );

  const subscriptions = [];

  for (const id of Array.isArray(ids) ? ids : []) {
    const subscription = await getJSON(
      `hadii:push:sub:${id}`,
      null
    );

    if (subscription) {
      subscriptions.push({ id, subscription });
    }
  }

  const remaining = [];
  let sent = 0;
  let removed = 0;

  for (const event of pending) {
    const record = await getJSON(
      `hadii:signal:${event.signalId}`,
      null
    );

    const payload = notificationFor(event, record);

    if (!payload || subscriptions.length === 0) {
      remaining.push(event);
      continue;
    }

    let failed = false;

    for (const item of subscriptions) {
      try {
        await sendPushNotification(item.subscription, payload);
        sent++;
      } catch (error) {
        const statusCode = error.statusCode;

        if (statusCode === 404 || statusCode === 410) {
          await redisCommand(
            "srem",
            "hadii:push:subscription-ids",
            item.id
          );

          await redisCommand(
            "del",
            `hadii:push:sub:${item.id}`
          );

          removed++;
        } else {
          failed = true;
        }
      }
    }

    if (failed || subscriptions.length === 0) {
      remaining.push(event);
    }
  }

  return { remaining, sent, removed };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return send(res, 405, {
      success: false,
      message: "POST only"
    });
  }

  const secret = process.env.MONITOR_SECRET;
  const authorization = req.headers.authorization || "";

  if (!secret || authorization !== `Bearer ${secret}`) {
    return send(res, 401, {
      success: false,
      message: "Unauthorized"
    });
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
      gold.dataStatus !== "LIVE" ||
      gold.marketStatus !== "OPEN"
    ) {
      const pending = await getJSON(PENDING_KEY, []);
      const delivery = await deliverPendingEvents(pending);
      await saveJSON(PENDING_KEY, delivery.remaining);

      return send(res, 200, {
        success: true,
        monitored: false,
        reason: gold.signalBlockReason || gold.message || "Live data unavailable",
        notificationsSent: delivery.sent
      });
    }

    const signals = Array.isArray(gold.strategy?.signals)
      ? gold.strategy.signals
      : [];

    let activeIds = await getJSON("hadii:active-signals", []);
    if (!Array.isArray(activeIds)) activeIds = [];

    const events = [];
    let newCount = 0;

    for (const signal of signals) {
      if (!signal.id || !["BUY", "SELL"].includes(signal.direction)) {
        continue;
      }

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

        if (!activeIds.includes(signal.id)) {
          activeIds.push(signal.id);
        }

        newCount++;

        events.push(makeEvent("NEW_SIGNAL", signal.id, {
          direction: signal.direction,
          entry: signal.entry,
          sl: signal.sl,
          tp1: signal.tp1,
          tp2: signal.tp2
        }));
      }
    }

    const bid = Number(gold.quote?.bid);
    const ask = Number(gold.quote?.ask);

    if (
      !Number.isFinite(bid) ||
      !Number.isFinite(ask) ||
      bid <= 0 ||
      ask < bid
    ) {
      throw new Error("Invalid live Gold bid/ask");
    }

    for (const id of [...new Set(activeIds)]) {
      const key = `hadii:signal:${id}`;
      const record = await getJSON(key, null);

      if (!record || record.status === "CLOSED") continue;

      const price = record.direction === "BUY" ? bid : ask;

      const sl = Number(record.sl);
      const tp1 = Number(record.tp1);
      const tp2 = Number(record.tp2);

      if (![sl, tp1, tp2].every(Number.isFinite)) continue;

      const hitSL = record.direction === "BUY"
        ? price <= sl
        : price >= sl;

      const hitTP1 = record.direction === "BUY"
        ? price >= tp1
        : price <= tp1;

      const hitTP2 = record.direction === "BUY"
        ? price >= tp2
        : price <= tp2;

      if (hitSL) {
        record.status = "CLOSED";
        record.closedAt = new Date().toISOString();

        events.push(makeEvent("SL_HIT", id));
      } else if (hitTP2) {
        if (!record.tp1Hit) {
          record.tp1Hit = true;
          events.push(makeEvent("TP1_HIT", id));
        }

        record.status = "CLOSED";
        record.closedAt = new Date().toISOString();

        events.push(makeEvent("TP2_HIT", id));
      } else if (hitTP1 && !record.tp1Hit) {
        record.tp1Hit = true;
        events.push(makeEvent("TP1_HIT", id));
      }

      await saveJSON(key, record);
    }

    activeIds = [...new Set(activeIds)].slice(-MAX_ACTIVE_SIGNALS);
    await saveJSON("hadii:active-signals", activeIds);

    const oldPending = await getJSON(PENDING_KEY, []);
    const combined = [
      ...(Array.isArray(oldPending) ? oldPending : []),
      ...events
    ];

    const uniquePending = [
      ...new Map(combined.map(event => [event.id, event])).values()
    ];

    await saveJSON(PENDING_KEY, uniquePending);

    const delivery = await deliverPendingEvents(uniquePending);

    await saveJSON(PENDING_KEY, delivery.remaining);

    return send(res, 200, {
      success: true,
      monitored: true,
      newSignals: newCount,
      events,
      notificationsSent: delivery.sent,
      expiredSubscriptionsRemoved: delivery.removed,
      pendingNotifications: delivery.remaining.length,
      checkedAt: new Date().toISOString()
    });

  } catch (error) {
    return send(res, 500, {
      success: false,
      message: error.message
    });
  }
}
