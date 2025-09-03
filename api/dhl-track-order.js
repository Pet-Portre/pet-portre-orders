// api/dhl-track-order.js
// Works with both ESM and CJS runtimes on Vercel.

const { MongoClient } = require("mongodb");

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "pet-portre"; // <- this is the DB that actually contains the 'orders' collection

async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, error: "method not allowed" });
      return;
    }

    // read query params in a runtime-agnostic way
    const url = new URL(req.url, "http://local");
    let tracking = (url.searchParams.get("tracking") || "").trim();
    const ref    = (url.searchParams.get("ref") || "").trim();

    // If only ref is provided, resolve tracking from Mongo
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
          ],
        });
        tracking = (doc && (doc.delivery?.trackingNumber || doc.trackingNumber)) || "";
      } finally {
        try { await client?.close(); } catch {}
      }
    }

    // Always return a valid payload (your Apps Script expects this shape)
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

    // (Optional) Call the real carrier API here. For now, echo a safe state.
    res.status(200).json({
      ok: true,
      status: "IN_TRANSIT",
      deliveredAt: null,
      trackingNumber: tracking,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "internal error" });
  }
}

// --- dual export to satisfy any loader ---
module.exports = handler;           // CommonJS
module.exports.default = handler;   // in case the wrapper looks at .default
