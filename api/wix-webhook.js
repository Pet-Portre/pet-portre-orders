// api/wix-webhook.js
const { MongoClient } = require("mongodb");

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "pet-portre";
const WEBHOOK_TOKEN = process.env.WIX_WEBHOOK_TOKEN || "";

let _clientPromise;
function getClient() {
  if (!_clientPromise) _clientPromise = new MongoClient(uri).connect();
  return _clientPromise;
}

// tiny helpers
const val = (o, p, d = undefined) =>
  p.split(".").reduce((a, k) => (a && a[k] != null ? a[k] : undefined), o) ?? d;

function joinAddress(addr) {
  if (!addr) return "";
  const parts = [
    addr.addressLine || addr.addressLine1 || addr.line1,
    addr.addressLine2 || addr.line2,
    addr.city || addr.locality,
    addr.region || addr.state,
    addr.postalCode || addr.zip,
    addr.country,
  ]
    .filter(Boolean)
    .join(", ");
  return parts;
}

function mapItem(it) {
  const variants = {};
  const options = it.options || it.choices || it.attributes || [];
  const readOpt = (label) => {
    const f =
      options.find(
        (o) =>
          (o.name || o.title || "").toLowerCase() === label.toLowerCase()
      ) ||
      options.find(
        (o) =>
          (o.option || o.label || "").toLowerCase() === label.toLowerCase()
      );
    return f ? f.value || f.selection || f.choice || "" : "";
  };

  variants.tshirtSize = readOpt("Beden") || readOpt("Size");
  variants.gender = readOpt("Cinsiyet") || readOpt("Gender");
  variants.color = readOpt("Renk") || readOpt("Color");
  variants.phoneModel = readOpt("Telefon Modeli") || readOpt("Phone Model");
  variants.portraitSize = readOpt("Tablo Boyutu") || readOpt("Portrait Size");

  const unitPrice =
    val(it, "price.amount") ??
    val(it, "priceData.amount") ??
    val(it, "price") ??
    val(it, "priceData.unitAmount") ??
    0;

  return {
    sku: it.sku || it.productSku || it.catalogSku || it.productId || "",
    name: it.name || it.title || "",
    qty: Number(it.quantity || it.qty || 1),
    unitPrice: Number(unitPrice) || 0,
    variants,
  };
}

function transformToOrder(doc) {
  const shipping = val(doc, "shippingAddress") || val(doc, "delivery.address");
  const billing = val(doc, "billingInfo") || val(doc, "billingAddress");
  const contact = val(doc, "contact") || val(doc, "buyer") || {};

  const first =
    val(contact, "firstName") ||
    val(billing, "firstName") ||
    val(shipping, "firstName") ||
    "";
  const last =
    val(contact, "lastName") ||
    val(billing, "lastName") ||
    val(shipping, "lastName") ||
    "";
  const phone =
    val(contact, "phone") ||
    val(billing, "phone") ||
    val(shipping, "phone") ||
    val(doc, "phone") ||
    "";
  const email =
    val(contact, "email") ||
    val(billing, "email") ||
    val(doc, "buyerEmail") ||
    "";

  const items =
    val(doc, "lineItems") ||
    val(doc, "items") ||
    val(doc, "cart.lineItems") ||
    [];

  const totals = {
    grandTotal:
      Number(val(doc, "totals.total")) ||
      Number(val(doc, "totals.grandTotal")) ||
      Number(val(doc, "totalAmount")) ||
      Number(val(doc, "priceSummary.total")) ||
      0,
    shipping:
      Number(val(doc, "totals.shipping")) ||
      Number(val(doc, "shippingPrice")) ||
      0,
    discount:
      Number(val(doc, "totals.discount")) ||
      Number(val(doc, "discountAmount")) ||
      0,
    currency:
      val(doc, "currency") ||
      val(doc, "totals.currency") ||
      val(doc, "priceSummary.currency") ||
      "TRY",
  };

  const orderNumber =
    String(val(doc, "orderNumber")) ||
    String(val(doc, "number")) ||
    String(val(doc, "id")) ||
    String(val(doc, "_id") || "");

  const createdAt =
    val(doc, "createdAt") ||
    val(doc, "dateCreated") ||
    val(doc, "createdDate") ||
    new Date();

  const paymentMethod =
    val(doc, "paymentMethod") ||
    val(doc, "payment.provider") ||
    val(doc, "transactions[0].gateway") ||
    "";

  return {
    channel: "wix",
    orderNumber,
    createdAt: new Date(createdAt),
    customer: {
      name: `${first} ${last}`.trim(),
      email,
      phone,
      address: { line1: joinAddress(shipping) },
    },
    delivery: {
      courier: "", // set later by create-order flow
      trackingNumber: "",
      status: "NEW",
    },
    items: (items || []).map(mapItem),
    payment: { method: paymentMethod },
    supplier: {},
    totals,
    notes:
      val(doc, "note") ||
      val(doc, "buyerNote") ||
      val(doc, "remarks") ||
      "",
    updatedAt: new Date(),
  };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ ok: false, error: "method not allowed" });

    if ((req.query.token || "") !== WEBHOOK_TOKEN)
      return res.status(401).json({ ok: false, error: "unauthorized" });

    // body may arrive parsed or as string depending on Wix; handle both
    let payload = req.body;
    if (!payload || typeof payload === "string") {
      try {
        payload = JSON.parse(payload || "{}");
      } catch {
        payload = {};
      }
    }

    const client = await getClient();
    const db = client.db(dbName);

    // store raw for auditing
    await db.collection("raw_events").insertOne({
      receivedAt: new Date(),
      source: "wix-automation",
      payload,
    });

    const orderDoc = transformToOrder(payload);
    if (!orderDoc.orderNumber) {
      return res.status(200).json({
        ok: true,
        storedRaw: true,
        note: "No orderNumber in payload; skipped upsert to orders.",
      });
    }

    // upsert into orders
    await db.collection("orders").updateOne(
      { channel: "wix", orderNumber: orderDoc.orderNumber },
      {
        $set: orderDoc,
        $setOnInsert: { createdAt: orderDoc.createdAt || new Date() },
      },
      { upsert: true }
    );

    res.status(200).json({ ok: true, orderNumber: orderDoc.orderNumber });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
};
