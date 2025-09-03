// api/wix-webhook.js
import { getDb } from "../lib/db.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "method not allowed" });
    }

    const expected = process.env.WIX_WEBHOOK_TOKEN;
    const given = new URL(req.url, "http://local").searchParams.get("token");
    if (expected && given !== expected) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    // Wix Automations "Send HTTP request" → Body = Entire payload
    const body = await readJson(req);

    // Very defensive extraction (Wix payloads vary by template/apps)
    const orderNumber = String(
      body?.orderNumber ?? body?.number ?? body?.id ?? body?.orderId ?? ""
    );

    const createdAt = body?.createdDate || body?.createdAt || new Date();

    const customer = {
      name: body?.buyerName || body?.customer?.name || "",
      email: body?.buyerEmail || body?.customer?.email || "",
      phone: body?.buyerPhone || body?.customer?.phone || "",
      address: {
        line1: body?.shippingAddress?.addressLine || body?.shippingInfo?.shippingAddress?.addressLine || ""
      }
    };

    const items = Array.isArray(body?.lineItems)
      ? body.lineItems.map(li => ({
          sku: li.sku || "",
          name: li.name || li.productName || "",
          qty: Number(li.quantity ?? 1),
          unitPrice: Number(li.priceData?.price?.amount ?? li.price ?? 0),
          variants: {
            tshirtSize: li.options?.tshirtSize || "",
            gender:     li.options?.gender || "",
            color:      li.options?.color || "",
            phoneModel: li.options?.phoneModel || "",
            portraitSize: li.options?.portraitSize || ""
          }
        }))
      : [];

    const payment = {
      method: body?.paymentMethod || body?.paymentInfo?.paymentMethod || "paytr"
    };

    const totals = {
      grandTotal: Number(body?.totals?.total?.amount ?? body?.totalPrice ?? 0),
      shipping:   Number(body?.totals?.shipping?.amount ?? body?.shippingPrice ?? 0),
      discount:   Number(body?.totals?.discount?.amount ?? body?.discount ?? 0),
      currency:   body?.currency || body?.totals?.total?.currency || "TRY"
    };

    const doc = {
      channel: "wix",
      orderNumber,
      createdAt: new Date(createdAt),
      customer,
      items,
      payment,
      totals,
      delivery: {
        courier: "",              // set when you create/print labels
        trackingNumber: "",       // set later
        status: "",               // set by tracking job
        cargoDispatchDate: null,  // set when handed to courier
        dateDelivered: null,      // set by tracking job
        referenceIdPlaceholder: ""// we may set "<KANAL><NO>" later from Sheets
      },
      supplier: {
        name: "", orderId: "", cargoCompany: "", cargoTrackingNo: "",
        givenAt: null, receivedAt: null
      },
      notes: body?.note || "",
      _raw: body,                // keep the raw event for troubleshooting
      updatedAt: new Date()
    };

    const db = await getDb();
    const col = db.collection("orders");

    // upsert by orderNumber + channel to avoid duplicates
    await col.updateOne(
      { channel: "wix", orderNumber },
      { $set: doc, $setOnInsert: { _createdByWebhookAt: new Date() } },
      { upsert: true }
    );

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message || "internal error" });
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8") || "{}";
  return JSON.parse(text);
}
