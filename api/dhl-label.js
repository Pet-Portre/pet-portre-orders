// api/dhl-track-order.js
const { MongoClient } = require("mongodb");

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "pet-portre"; // use the DB that actually has your 'orders' collection

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, error: "method not allowed" });
      return;
    }

    // read query params
    const url = new URL(req.url, "http://x");
    let tracking = (url.searchParams.get("tracking") || "").trim();
    const ref   = (url.searchParams.get("ref") || "").trim();

    // if no tracking but we have a ref, resolve from Mongo
    if (!tracking && ref && URI) {
      let client;
      try {
        client = new MongoClient(URI);
        await client.connect();
        const db = client.db(DB);
        const doc = await db.collection("orders").findOne({
          $or: [
            { "delivery.referenceId": ref },
            { referenceId: ref },
          ],
        });
        tracking =
          (doc && (doc.delivery?.trackingNumber || doc.trackingNumber)) || "";
      } finally {
        try { await client?.close(); } catch {}
      }
    }

    // always return a valid shape for your Google Sheet
    if (!tracking) {
      res.status(200).json({
        ok: true,
        status: "UNKNOWN",
        deliveredAt: null,
        trackingNumber: "",
        note: "no tracking supplied",
      });
      return;
    }

    // provider call can be added later; echo a safe response now
    res.status(200).json({
      ok: true,
      status: "IN_TRANSIT",
      deliveredAt: null,
      trackingNumber: tracking,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "internal error" });
  }
};
