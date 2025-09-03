// api/dhl-track-order.js
// Max-compat: supports default export, CJS, and AWS-style exports.handler.

import { MongoClient } from "mongodb";

const URI = process.env.MONGODB_URI;
const DB  = process.env.MONGODB_DB || "pet-portre"; // this is the database name that contains 'orders'

// The real logic
async function coreHandler(req, res) {
  try {
    // Node/Express shape
    if (req && res && typeof res.status === "function") {
      if (req.method !== "GET") {
        res.status(405).json({ ok: false, error: "method not allowed" });
        return;
      }

      const url = new URL(req.url, "http://local");
      let tracking = (url.searchParams.get("tracking") || "").trim();
      const ref    = (url.searchParams.get("ref") || "").trim();

      // If only ref is given, try to resolve tracking from Mongo
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
        res.status(200).json({
          ok: true,
          status: "UNKNOWN",
          deliveredAt: null,
          trackingNumber: ""
        });
        return;
      }

      // TODO: call your real carrier API here; stubbed for now:
      res.status(200).json({
        ok: true,
        status: "IN_TRANSIT",
        deliveredAt: null,
        trackingNumber: tracking
      });
      return;
    }

    // Fetch/Web style fallback (rare on Vercel Node, but safe)
    const url = new URL(req.url);
    const body = { ok: true, status: "UNKNOWN", deliveredAt: null, trackingNumber: url.searchParams.get("tracking") || "" };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

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

// ---- Export in every shape the launcher might expect ----

// ESM default (Vercel Node prefers this)
export default coreHandler;

// CJS default (older launchers)
try {
  // module is undefined under pure ESM, so guard:
  if (typeof module !== "undefined") {
    module.exports = coreHandler;
    // AWS-style symbol some launchers look for:
    module.exports.handler = coreHandler;
    // Also put a named export on exports just in case:
    exports.handler = coreHandler;
  }
} catch { /* noop */ }
