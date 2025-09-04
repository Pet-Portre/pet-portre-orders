import { getDb } from "../lib/db";

// Accepts POST { referenceId, receiver{...}, order{...} }
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const payload = req.body || {};
    const ref = (payload.referenceId || "").toString();
    if (!ref) return res.status(400).json({ ok: false, error: "referenceId required" });

    // TODO: call DHL/MNG create-order here if you want server-side creation.
    // For now we just store reference placeholder and echo success.

    const db = await getDb();
    await db.collection("orders").updateOne(
      { channel: { $in: ["wix", "trendyol"] }, orderNumber: payload.order?.orderNumber || "__unknown__" },
      {
        $set: {
          "delivery.referenceIdPlaceholder": ref,
          "delivery.courier": "MNG Kargo",
          "delivery.status": "CREATED",
          updatedAt: new Date()
        }
      },
      { upsert: false }
    );

    return res.status(200).json({
      ok: true,
      referenceId: ref,
      carrier: "MNG Kargo",
      trackingNumber: ""
    });
  } catch (e) {
    console.error("dhl-create-order error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
