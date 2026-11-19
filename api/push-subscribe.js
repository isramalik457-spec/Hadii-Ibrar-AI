
import { createHash } from "crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      message: "POST only"
    });
  }

  try {
    const subscription = req.body;

    if (
      !subscription ||
      !subscription.endpoint ||
      !subscription.keys ||
      !subscription.keys.p256dh ||
      !subscription.keys.auth
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid push subscription"
      });
    }

    const redisUrl = process.env.KV_REST_API_URL;
    const redisToken = process.env.KV_REST_API_TOKEN;

    if (!redisUrl || !redisToken) {
      throw new Error("Redis configuration missing");
    }

    const id = createHash("sha256")
      .update(subscription.endpoint)
      .digest("hex");

    async function redis(command) {
      const response = await fetch(redisUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${redisToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(command)
      });

      if (!response.ok) {
        throw new Error("Redis request failed");
      }

      return response.json();
    }

    await redis([
      "SET",
      `hadii:push:sub:${id}`,
      JSON.stringify(subscription)
    ]);

    await redis([
      "SADD",
      "hadii:push:subscription-ids",
      id
    ]);

    return res.status(200).json({
      success: true,
      message: "Push subscription saved"
    });

  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Could not save subscription"
    });
  }
}
