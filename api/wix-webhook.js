// /api/wix-webhook.js
// Vercel (Node 18/20) – handles Wix “Order placed” automation
// - GET  → quick health check (so you can open it in the browser)
// - POST → verifies ?token= and upserts the Wix order into MongoDB

import { MongoClient } from "mongodb";

/** --- CONFIG --- */
const DB_NAME = process.env.MONGODB_DB || "pet-portre";         // your Atlas DB name (matches the “pet-portre.orders” namespace)
const COL_NAME = "orders";                                       // collection to store orders
const WEBHOOK_TOKEN = process.env.WIX_WEBHOOK_TOKEN || "";       // set in Vercel

// cached connection across invocations
let _client;
async function getDb() {
  if (!_client || !_client.topology || _client.topology.isDestroyed()) {
    _client = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 10,
    });
    await _client.connect();
  }
  return _client.db(DB_NAME);
}

/** safe getter */
const get = (obj, path, dflt = undefined) =>
  path.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : dflt), obj);

/** normalize string (trim, empty → "") */
const s = (v) => (v == null ? "" : String(v).trim());

/** build our canonical order document from a very tolerant Wix payload */
function buildDoc(payload) {
  // Wix automation payloads differ depending on settings; try multiple shapes.
  const order =
    payload?.order ||
    payload?.entity ||
    payload?.data ||
    payload || {};

  const number =
    s(get(order, "number")) ||
    s(get(order, "orderNumber")) ||
    s(get(order, "id")) ||
    s(get(order, "_id"));

  const createdAt =
    get(order, "createdDate") ||
    get(order, "createdAt") ||
    get(order, "dateCreated") ||
    new Date();

  const customer = {
    name:
      s(get(order, "buyer.fullName")) ||
      s(get(order, "buyer.name")) ||
      s(get(order, "customer.name")) ||
      s(get(order, "shippingInfo.recipient.name")) ||
      "",
    email:
      s(get(order, "buyer.email")) ||
      s(get(order, "customer.email")) ||
      s(get(order, "contact.email")) ||
      "",
    phone:
      s(get(order, "buyer.phone")) ||
      s(get(order, "customer.phone")) ||
      s(get(order, "shippingInfo.recipient.phone")) ||
      s(get(order, "shippingInfo.phone")) ||
      "",
    address: {
      line1:
        s(get(order, "shippingInfo.shippingAddress.addressLine")) ||
        s(get(order, "shippingInfo.shippingAddress.formattedAddress")) ||
        s(get(order, "shippingInfo.logistics.address.addressLine")) ||
        s(get(order, "shippingInfo.address.addressLine")) ||
        "",
      city:
        s(get(order, "shippingInfo.shippingAddress.city")) ||
        s(get(order, "shippingInfo.logistics.address.city")) ||
        "",
      district:
        s(get(order, "shippingInfo.shippingAddress.subdivision")) ||
        s(get(order, "shippingInfo.logistics.address.subdivision")) ||
        "",
      postcode:
        s(get(order, "shippingInfo.shippingAddress.postalCode")) ||
        s(get(order, "shippingInfo.logistics.address.postalCode")) ||
        "",
    },
  };

  // line items
  const itemsRaw =
    get(order, "lineItems", []) ||
    get(order, "items", []) ||
    [];
  const items = (Array.isArray(itemsRaw) ? itemsRaw : []).map((li) => ({
    sku: s(li?.sku) || s(li?.catalogReference?.catalogItemId) || "",
    name: s(li?.name) || s(li?.productName) || "",
    qty: Number(li?.quantity) || 1,
    unitPrice:
      Number(get(li, "priceData.price")) ||
      Number(get(li, "price")) ||
      Number(get(li, "itemPrice")) ||
      0,
    variants: {
      tshirtSize: s(get(li, "options.size")) || s(get(li, "variants.size")) || "",
      gender: s(get(li, "options.gender")) || s(get(li, "variants.gender")) || "",
      color: s(get(li, "options.color")) || s(get(li, "variants.color")) || "",
      phoneModel:
        s(get(li, "options.phoneModel")) || s(get(li, "variants.phoneModel")) || "",
      portraitSize:
        s(get(li, "options.portraitSize")) || s(get(li, "variants.portraitSize")) || "",
    },
  }));

  // totals & payment
  const totals = {
    grandTotal:
      Number(get(order, "priceSummary.total")) ||
      Number(get(order, "totals.total")) ||
      Number(get(order, "totalPrice")) ||
      0,
    shipping:
      Number(get(order, "priceSummary.shipping")) ||
      Number(get(order, "totals.shipping")) ||
      0,
    discount:
      Number(get(order, "priceSummary.discount")) ||
      Number(get(order, "totals.discount")) ||
      0,
    currency:
      s(get(order, "currency")) ||
      s(get(order, "totals.currency")) ||
      "TRY",
  };

  const payment = {
    method:
      s(get(order, "paymentMethod")) ||
      s(get(order, "paymentInfo.method")) ||
      s(get(order, "paymentDetails.method")) ||
      "", // you often see "paytr" here in your data
    status:
      s(get(order, "paymentStatus")) ||
      s(get(order, "financialStatus")) ||
      "",
  };

  // delivery/tracking – may be empty on creation
  const delivery = {
    courier: s(get(order, "shippingInfo.carrier")) || "",
    trackingNumber:
      s(get(order, "shippingInfo.trackingNumber")) ||
      s(get(order, "trackingInfo.number")) ||
      "",
    status:
      s(get(order, "fulfillmentStatus")) ||
      s(get(order, "delivery.status")) ||
      "",
  };

  return {
    channel: "wix",
    orderNumber: number,          // your sheet expects "10030" style strings
    _createdByWebhookAt: new Date(),
    createdAt: createdAt ? new Date(createdAt) : new Date(),
    customer,
    items,
    payment,
    delivery,
    totals,
    notes: s(get(order, "buyerNote")) || s(get(order, "notes")) || "",
    supplier: {},                 // left for your internal use; unchanged
    updatedAt: new Date(),
    raw: payload,                 // keep the raw payload for audit/patching later
  };
}

export default async function handler(req, res) {
  try {
    // 1) Health check for quick browser test
    if (req.method === "GET") {
      return res.status(200).json({ ok: true, info: "wix-webhook alive" });
    }

    // 2) Only POST is allowed from Wix
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "method not allowed" });
    }

    // 3) Token guard
    if (!WEBHOOK_TOKEN || req.query?.token !== WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // 4) Parse + build document
    const payload = req.body || {};
    const doc = buildDoc(payload);

    if (!doc.orderNumber) {
      // If Wix didn’t send a human order number, fail fast (so we can fix mapping).
      return res.status(400).json({ ok: false, error: "missing orderNumber" });
    }

    // 5) Upsert into MongoDB by orderNumber + channel = 'wix'
    const db = await getDb();
    await db.collection(COL_NAME).updateOne(
      { channel: "wix", orderNumber: doc.orderNumber },
      {
        $set: {
          // immutable-ish fields – only set if not present
          channel: "wix",
          orderNumber: doc.orderNumber,
        },
        $setOnInsert: {
          createdAt: doc.createdAt,
          _createdByWebhookAt: doc._createdByWebhookAt,
        },
        // always refresh these
        $currentDate: { updatedAt: true },
        $push: { _events: { type: "webhook:order_placed", at: new Date() } },
        $set: {
          customer: doc.customer,
          items: doc.items,
          payment: doc.payment,
          delivery: doc.delivery,
          totals: doc.totals,
          notes: doc.notes,
          raw: doc.raw,
        },
      },
      { upsert: true }
    );

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("wix-webhook error:", err);
    return res.status(500).json({ ok: false, error: err.message || "server error" });
  }
}
