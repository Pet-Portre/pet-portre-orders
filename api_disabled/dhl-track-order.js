// api/dhl-track-order.js  (CommonJS)
const { MongoClient } = require("mongodb");

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "pet-portre";

async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, error: "method not allowed" });
      return;
    }

    const url = new URL(req.url, "http://local");
    let tracking = (url.searchParams.get("tracking") || "").trim();
    const ref    = (url.searchParams.get("ref") || "").trim();

    if (!tracking && ref && URI) {
      let client;
      try {
        client = new MongoClient(URI);
        await client.connect();
        const db = client.db(DB);
        const doc = await db.collection("orders").findOne({
          $or: [
            { "delivery.referenceId": ref },
            { referenceId: ref }
          ]
        });
        tracking = doc?.delivery?.trackingNumber || doc?.trackingNumber || "";
      } finally {
        try { await client?.close(); } catch {}
      }
    }

    if (!tracking) {
      res.status(200).json({ ok: true, status: "UNKNOWN", deliveredAt: null, trackingNumber: "" });
      return;
    }

    // TODO: call real carrier API; stubbed:
    res.status(200).json({ ok: true, status: "IN_TRANSIT", deliveredAt: null, trackingNumber: tracking });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "internal error" });
  }
}

// EXPORT **AS A FUNCTION**
module.exports = handler;         // <- Vercel launcher will call this
module.exports.handler = handler; // <- also expose AWS-style symbol (belt & suspenders)
