// api/wix-webhook.js
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "pet-portre"; // <- use the DB that actually has 'orders'
const expectedToken = process.env.WIX_WEBHOOK_TOKEN;

function bad(res, code, msg) {
  res.status(code).json({ ok: false, error: msg });
}

async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// very tolerant mapper; fills what we can, leaves the rest
function tryMapWixOrder(evt) {
  // Wix Automations payloads vary; look for commonly present fields
  const o = evt?.order || evt?.data?.order || evt?.payload?.order || null;
  const id = o?.number || o?.id || evt?.orderId || evt?.data?.orderId || null;

  if (!id && !o) return null;

  const customer = o?.buyerInfo || o?.buyer || evt?.customer || {};
  const shipping = o?.shippingInfo || o?.shipping || o?.delivery || {};
  const address =
    shipping?.address ||
    shipping?.shippingAddress ||
    evt?.shippingAddress ||
    {};

  const itemsSrc = o?.lineItems || o?.items || evt?.items || [];
  const items = (Array.isArray(itemsSrc) ? itemsSrc : []).map(it => ({
    sku: it.sku || it.catalogReference?.catalogItemId || "",
    name: it.name || it.description || "",
    qty: Number(it.quantity || it.qty || 1),
    unitPrice: Number(
      it.priceData?.price ||
      it.price ||
      it.unitPrice ||
      0
    )
  }));

  const totals = {
    currency:
      o?.priceSummary?.currency ||
      o?.currency ||
      evt?.currency ||
      "TRY",
    grandTotal:
      Number(o?.priceSummary?.total || o?.grandTotal || evt?.total || 0),
    shipping: Number(o?.priceSummary?.shipping || 0),
    discount: Number(o?.priceSummary?.discount || 0)
  };

  return {
    channel: "wix",
    orderNumber: String(id || "").replace(/^#/, ""),
    createdAt: new Date(o?.createdDate || evt?.createdAt || Date.now()),
    customer: {
      name:
        customer?.fullName ||
        [customer?.firstName, customer?.lastName].filter(Boolean).join(" ") ||
        "",
      email: customer?.email || evt?.buyerEmail || "",
      phone: customer?.phone || evt?.buyerPhone || ""
    },
    delivery: {
      courier: "", // filled later when you create DHL/MNG order
      trackingNumber: "",
      referenceId: "", // set later by Create Order flow
      address: {
        line1:
          address?.addressLine1 ||
          address?.line1 ||
          [address?.street, address?.houseNumber]
            .filter(Boolean)
            .join(" ") ||
          "",
        line2: address?.addressLine2 || address?.line2 || "",
        city: address?.city || "",
        district: address?.subdivision || address?.district || "",
        postcode: address?.postalCode || address?.zip || ""
      }
    },
    items,
    payment: {
      method:
        o?.paymentStatus || o?.gateway || evt?.paymentMethod || "" // best effort
    },
    totals,
    notes: o?.buyerNote || evt?.note || ""
  };
}

export default async function handler(req, res) {
  // 1) Health check
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, info: "wix-webhook alive" });
  }

  // 2) Only POST allowed for events
  if (req.method !== "POST") {
    return bad(res, 405, "method not allowed");
  }

  // 3) Token guard
  const q = new URL(req.url, "http://x").searchParams;
  const token = q.get("token");
  if (expectedToken && token !== expectedToken) {
    return bad(res, 401, "invalid token");
  }

  // 4) Read & parse safely
  let raw = "";
  let evt = null;
  try {
    raw = await readRawBody(req);
    evt = raw ? JSON.parse(raw) : {};
  } catch (e) {
    // keep raw around for debugging
    evt = { _parseError: e.message, raw };
  }

  // 5) DB
  let client;
  try {
    client = new MongoClient(uri);
    await client.connect();
    const db = client.db(dbName);

    // Always persist the raw event for auditing/debug
    const rawDoc = {
      source: "wix",
      receivedAt: new Date(),
      headers: req.headers,
      event: evt
    };
    await db.collection("raw_events").insertOne(rawDoc);

    // Try to map into 'orders' (best effort). If mapping fails, we still return 200.
    try {
      const order = tryMapWixOrder(evt);
      if (order?.orderNumber) {
        await db.collection("orders").updateOne(
          { channel: "wix", orderNumber: order.orderNumber },
          { $set: order },
          { upsert: true }
        );
      }
    } catch (mapErr) {
      // swallow mapping errors; you still have raw_events
      console.error("map/order upsert error:", mapErr?.message);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("webhook error:", e?.message);
    return bad(res, 500, e.message || "internal error");
  } finally {
    try { await client?.close(); } catch (_) {}
  }
}
