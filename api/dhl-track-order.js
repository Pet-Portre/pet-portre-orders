// api/dhl-track-order.js
// Works on Vercel Node runtime even if your project mixes ESM/CJS.
// Exports both a default ESM handler and (when available) a CJS module.exports.

import { MongoClient } from "mongodb";

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "pet-portre"; // <-- this is the DB that holds your 'orders' collection

async function handler(req, res) {
  try {
    // Node-style guard (Vercel Node runtime passes req/res)
    if (req && res && typeof res.status === "function") {
      if (req.method !== "GET") {
        res.status(405).json({ ok: false, error: "method not allowed" });
        return;
      }

      const url = new URL(req.url, "http://local");
      let tracking = (url.searchParams.get("tracking") || "").trim();
      const ref    = (url.searchParams.get("ref") || "").trim();

      // Resolve tracking by ref (from Mongo) if needed
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

      // Always return a safe shape
      if (!tracking) {
        res.status(200).json({
          ok: true,
          status: "UNKNOWN",
          deliveredAt: null,
          trackingNumber: ""
        });
        return;
      }

      res.status(200).json({
        ok: true,
        status: "IN_TRANSIT",
        deliveredAt: null,
        trackingNumber: tracking
      });
      return;
    }

    // Fallback for environments that expect a web Response (shouldn't be needed on Vercel Node)
    const ok = {
      ok: true,
      status: "UNKNOWN",
      deliveredAt: null,
      trackingNumber: ""
    };
    return new Response(JSON.stringify(ok), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    if (res && typeof res.status === "function") {
      res.status(500).json({ ok: false, error: e?.message || "internal error" });
    } else {
      return new Response(JSON.stringify({ ok: false, error: e?.message || "internal error" }), {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    }
  }
}

// ESM default export
export default handler;

// CJS export when available (avoids ReferenceError in ESM)
if (typeof module !== "undefined") {
  module.exports = handler;
}
