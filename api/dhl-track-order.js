// api/dhl-track-order.js  (ESM default export; Vercel will call this)
import { MongoClient } from "mongodb";

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "pet-portre"; // this is the DB that actually holds your 'orders' collection

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.status(405).json({ ok: false, error: "method not allowed" });
      return;
    }

    const url = new URL(req.url, "http://local");
    let tracking = (url.searchParams.get("tracking") || "").trim();
    const ref    = (url.searchParams.get("ref") || "").trim();

    // If the caller only gave ?ref=, try to resolve a tracking number from Mongo
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

    // Always respond with a safe shape your Apps Script expects
    if (!tracking) {
      res.status(200).json({
        ok: true,
        status: "UNKNOWN",
        deliveredAt: null,
        trackingNumber: ""
      });
      return;
    }

    // (Hook to real carrier tracking here if/when you want)
    res.status(200).json({
      ok: true,
      status: "IN_TRANSIT",
      deliveredAt: null,
      trackingNumber: tracking
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || "internal error" });
  }
}
