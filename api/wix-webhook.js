import { getDb } from "../lib/db";

// Upsert normalized order docs into pet-portre.orders
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  // Token guard via query param (?token=…)
  const token = (req.query?.token || "").toString();
  const expected = process.env.WIX_WEBHOOK_TOKEN || "";
  if (!expected || token !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  try {
    const body = req.body || {};
    const db = await getDb();

    // Store raw payload for debugging
    await db.collection("raw_events").insertOne({
      source: "wix",
      receivedAt: new Date(),
      body
    });

    // ---- Minimal, safe normalization from Wix ----
    // Adjust selectors if your payload differs.
    const orderNumber = (body?.order?.number || body?.number || body?.orderNumber || "").toString();
    if (!orderNumber) return res.status(200).json({ ok: true, note: "no order number" });

    const createdAtStr = body?.order?.dateCreated || body?.dateCreated || body?.createdAt;
    const createdAt = createdAtStr ? new Date(createdAtStr) : new Date();

    const customer = {
      name: body?.buyer?.fullName || body?.buyer?.name || body?.billingInfo?.fullName || "",
      email: body?.buyer?.email || body?.email || "",
      phone: body?.buyer?.phone || body?.billingInfo?.phone || "",
      address: {
        line1: body?.shippingInfo?.address?.addressLine || body?.shippingInfo?.address?.street || "",
        line2: body?.shippingInfo?.address?.apartment || "",
        district: body?.shippingInfo?.address?.neighborhood || "",
        city: body?.shippingInfo?.address?.city || "",
        postcode: body?.shippingInfo?.address?.postalCode || ""
      }
    };

    // Items
    const itemsArr = Array.isArray(body?.lineItems) ? body.lineItems : (Array.isArray(body?.items) ? body.items : []);
    const items = itemsArr.map((it) => ({
      sku: it?.sku || "",
      name: it?.name || it?.productName || "",
      qty: Number(it?.quantity || 1),
      unitPrice: Number(it?.price?.amount || it?.price || 0),
      variants: {
        tshirtSize: it?.options?.tshirtSize || it?.variant?.size || "",
        gender: it?.options?.gender || "",
        color: it?.options?.color || it?.variant?.color || "",
        phoneModel: it?.options?.phoneModel || "",
        portraitSize: it?.options?.portraitSize || ""
      }
    }));

    const totals = {
      grandTotal: Number(body?.totals?.grandTotal?.amount || body?.grandTotal || body?.payment?.amount || 0),
      discount: Number(body?.totals?.discount?.amount || 0),
      shipping: Number(body?.totals?.shipping?.amount || 0),
      currency: (body?.currency || body?.totals?.currency || "TRY").toString()
    };

    const payment = {
      method: (body?.payment?.gatewayName || body?.payment?.method || "paytr").toString()
    };

    const delivery = {
      courier: "MNG Kargo",
      trackingNumber: "",
      status: ""
    };

    const doc = {
      channel: "wix",
      orderNumber,
      _createdByWebhookAt: new Date(),
      createdAt,
      updatedAt: new Date(),
      customer,
      items,
      totals,
      payment,
      delivery,
      supplier: {},   // optional
      notes: (body?.note || "").toString()
    };

    await db.collection("orders").updateOne(
      { channel: "wix", orderNumber },
      { $set: doc },
      { upsert: true }
    );

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("wix-webhook error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
