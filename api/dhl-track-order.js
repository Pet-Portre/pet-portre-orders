// api/dhl-track-order.js
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "pet-portre"; // use the DB that contains 'orders'
// If you have a provider endpoint, put it here. We'll no-op if it's missing.
const PROVIDER_QUERY_URL = process.env.DHL_STANDARD_QUERY_URL || "";

function bad(res, code, msg) {
  res.status(code).json({ ok: false, error: msg });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return bad(res, 405, "method not allowed");
    }

    const url = new URL(req.url, "http://x");
    let tracking = (url.searchParams.get("tracking") || "").trim();
    const ref = (url.searchParams.get("ref") || "").trim();

    // If only ref was given, try to resolve tracking from Mongo
    if (!tracking && ref) {
      let client;
      try {
        client = new MongoClient(uri);
        await client.connect();
        const db = client.db(dbName);
        const doc = await db.collection("orders").findOne({
          $or: [
            { "delivery.referenceId": ref },
            { referenceId: ref },
          ],
        });
        tracking =
          doc?.delivery?.trackingNumber ||
          doc?.trackingNumber ||
          "";
      } finally {
        try { await client?.close(); } catch {}
      }
    }

    if (!tracking) {
      // Give Sheets a graceful response (prevents crashes)
      return res.status(200).json({
        ok: true,
        status: "UNKNOWN",
        deliveredAt: null,
        trackingNumber: "",
        note: "no tracking supplied",
      });
    }

    // If you have a live provider, do the real query here.
    // Keeping it stubbed so the route works immediately.
    // Example skeleton:
    // const r = await fetch(`${PROVIDER_QUERY_URL}?tracking=${encodeURIComponent(tracking)}`, { method: "GET" });
    // const data = await r.json(); // adapt mapping...

    // Minimal, valid response shape for your Apps Script:
    return res.status(200).json({
      ok: true,
      status: "IN_TRANSIT",       // placeholder
      deliveredAt: null,          // or ISO string when delivered
      trackingNumber: tracking,   // echo back so Sheets writes it if missing
    });
  } catch (e) {
    return bad(res, 500, e.message || "internal error");
  }
}
