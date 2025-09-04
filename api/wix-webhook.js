// api/wix-webhook.js
import { getDb } from "../lib/db.js";

function ok(res, extra = {}) {
  res.status(200).json({ ok: true, ...extra });
}

function bad(res, msg, code = 400) {
  res.status(code).json({ ok: false, error: msg });
}

function authOk(req) {
  const want = process.env.WIX_WEBHOOK_TOKEN;
  if (!want) return true; // no token set => open (for now)
  const got = new URL(req.url, "http://x").searchParams.get("token");
  return got === want;
}

function toStr(x) { return (x == null ? "" : String(x)); }

function normalizePayload(body = {}) {
  // Accept either your CLI test shape or a Wix-ish shape
  const o = body.order || body;

  const createdAt =
    o.createdAt || body.createdDate || body.createdAt || new Date().toISOString();

  // Customer
  const first = body?.buyerInfo?.firstName || body?.customer?.firstName || "";
  const last  = body?.buyerInfo?.lastName  || body?.customer?.lastName  || "";
  const name  = body?.customer?.name || [first, last].filter(Boolean).join(" ") || "";
  const email = body?.customer?.email || body?.buyerInfo?.email || "";
  const phone = body?.customer?.phone || body?.buyerInfo?.phone || "";

  // Address (take a single line for now; we can expand later)
  const address =
    body?.address ||
    body?.billingInfo?.address?.address ||
    body?.shippingInfo?.address?.address ||
    body?.customer?.address ||
    "";

  // Items
  const rawItems = body.items || body.lineItems || o.lineItems || [];
  const items = (Array.isArray(rawItems) ? rawItems : []).map((it) => ({
    sku:  toStr(it.sku || it.code || it.variantId || it.id),
    name: toStr(it.name || it.title || ""),
    qty:  Number(it.qty || it.quantity || 1),
    price:Number(it.price?.amount ?? it.price ?? 0),
  }));

  // Totals
  const totalsSrc = body.totals || o.totals || {};
  const totals = {
    total:    Number(totalsSrc.total ?? totalsSrc.amount ?? 0),
    shipping: Number(totalsSrc.shipping ?? 0),
    discount: Number(totalsSrc.discount ?? 0),
    currency: toStr(totalsSrc.currency || "TRY"),
  };

  const orderNumber =
    toStr(o.number || o.orderNumber || body.orderNumber || body.id || "");

  return {
    channel: "wix",
    orderNumber,
    _createdByWebhookAt: new Date(),
    createdAt: new Date(createdAt),
    customer: { name, email, phone, address },
    delivery: {},
    items,
    supplier: {},
    totals,
    notes: toStr(body.notes || o.notes || ""),
  };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).send("POST only — wix-webhook");
    }

    if (!authOk(req)) return bad(res, "unauthorized", 401);

    const text = await new Response(req.body).text().catch(() => "");
    const body = text ? JSON.parse(text) : {};

    // health ping shortcut
    if (body.ping === true) return ok(res, { receivedAt: new Date().toISOString() });

    const doc = normalizePayload(body);
    if (!doc.orderNumber) return bad(res, "orderNumber missing", 422);

    const db = await getDb();
    await db.collection("orders").insertOne(doc);

    return ok(res, { orderNumber: doc.orderNumber });
  } catch (e) {
    console.error("wix-webhook error:", e?.stack || e);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
}
