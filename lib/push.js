
import webpush from "web-push";

export async function sendPushNotification(subscription, payload) {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;

  if (!publicKey || !privateKey || !subject) {
    throw new Error("VAPID configuration missing");
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);

  return await webpush.sendNotification(
    subscription,
    JSON.stringify(payload)
  );
}
