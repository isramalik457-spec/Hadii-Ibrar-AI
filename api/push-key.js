
export default function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      success: false,
      message: "GET only"
    });
  }

  const publicKey = process.env.VAPID_PUBLIC_KEY;

  if (!publicKey) {
    return res.status(500).json({
      success: false,
      message: "VAPID public key missing"
    });
  }

  res.setHeader("Cache-Control", "no-store");

  return res.status(200).json({
    success: true,
    publicKey
  });
}
