// api/wix-webhook.js
const getDb = require('../lib/db');

// small helper
function asNumber(x, d = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}
function safe(obj, path, d = undefined) {
  return path.split('.').reduce((o, k) => (o && o[k] != null ? o[k] : undefined), obj) ?? d;
}

module.exports = async (req, res) => {
  try {
    // 1) Method & token
    if (req.method !== 'POST') {
      return res.status(200).json({ ok: true, info: 'POST me your Wix payload' });
    }
    const expected = process.env.WIX_WEBHOOK_TOKEN || '';
    const token = (req.query.token || req.headers['x-webhook-token'] || '').toString();
    if (expected && token !== expected) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // 2) Parse body (Wix "Send HTTP request" → Entire payload)
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch {}
    }
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ ok: false, error: 'invalid body' });
    }

    // 3) Map as best we can (tolerant of different Wix shapes)
    const orderNumber =
      String(
        body.number ?? body.orderNumber ?? safe(body, 'order.number') ?? safe(body, 'id') ?? ''
      ).trim();

    if (!orderNumber) {
      return res.status(400).json({ ok: false, error: 'missing order number' });
    }

    const createdAtRaw =
      body.createdAt ||
      body.dateCreated ||
      safe(body, 'order.createdDate') ||
      new Date().toISOString();

    const buyer = body.buyer || body.customer || body.billingInfo || {};
    const shipping = body.shippingAddress || body.shippingInfo || {};
    const lineItems = body.lineItems || body.items || safe(body, 'order.lineItems') || [];

    const customer = {
      name:
        buyer.fullName ||
        [buyer.firstName, buyer.lastName].filter(Boolean).join(' ') ||
        shipping.fullName ||
        '',
      email: buyer.email || body.email || '',
      phone: shipping.phone || buyer.phone || '',
      address: {
        line1:
          shipping.addressLine ||
          [shipping.street, shipping.addressLine1, shipping.address1]
            .filter(Boolean)
            .join(' ') ||
          '',
        city: shipping.city || shipping.locality || '',
        district: shipping.district || '',
        postcode: shipping.postalCode || shipping.zip || '',
      },
    };

    const items = lineItems.map((it) => ({
      sku: it.sku || it.catalogId || it.productId || '',
      name: it.name || it.productName || '',
      qty: asNumber(it.quantity ?? it.qty ?? 1, 1),
      unitPrice: asNumber(
        safe(it, 'priceData.price') ?? it.price ?? it.unitPrice ?? it.totalPrice, 0
      ),
      variants: {
        tshirtSize: safe(it, 'options.size') || safe(it, 'variant.size') || '',
        gender: safe(it, 'options.gender') || '',
        color: safe(it, 'options.color') || '',
        phoneModel: safe(it, 'options.phoneModel') || '',
        portraitSize: safe(it, 'options.portraitSize') || '',
      },
    }));

    const totals = {
      grandTotal:
        asNumber(
          safe(body, 'totals.total') ??
            safe(body, 'priceSummary.grandTotal') ??
            body.totalPrice ??
            body.amount,
          0
        ),
      discount: asNumber(safe(body, 'priceSummary.discount') ?? body.discount, 0),
      shipping: asNumber(safe(body, 'priceSummary.shipping') ?? safe(body, 'shipping.price'), 0),
      currency: body.currency || safe(body, 'totals.currency') || 'TRY',
    };

    const payment = {
      method: body.paymentMethod || body.paymentProvider || body.gateway || '',
    };

    const delivery = {
      courier: safe(body, 'shippingInfo.carrier') || safe(body, 'delivery.courier') || '',
      trackingNumber:
        safe(body, 'shippingInfo.trackingNumber') || safe(body, 'delivery.trackingNumber') || '',
      cargoDispatchDate: safe(body, 'delivery.cargoDispatchDate') || null,
      dateDelivered: safe(body, 'delivery.dateDelivered') || null,
      status: safe(body, 'delivery.status') || '',
      referenceId: safe(body, 'delivery.referenceId') || '',
      referenceIdPlaceholder: safe(body, 'delivery.referenceIdPlaceholder') || '',
    };

    const doc = {
      channel: 'wix',
      orderNumber: String(orderNumber),
      createdAt: new Date(createdAtRaw),
      updatedAt: new Date(),
      customer,
      items,
      payment,
      totals,
      delivery,
      supplier: safe(body, 'supplier') || {},
      notes: body.note || body.buyerNote || '',
    };

    // 4) Upsert
    const db = await getDb();
    await db.collection('orders').updateOne(
      { channel: 'wix', orderNumber: doc.orderNumber },
      {
        $setOnInsert: { createdAt: doc.createdAt },
        $set: {
          updatedAt: doc.updatedAt,
          customer: doc.customer,
          items: doc.items,
          payment: doc.payment,
          totals: doc.totals,
          delivery: doc.delivery,
          supplier: doc.supplier,
          notes: doc.notes,
        },
        $push: { raw_events: { at: new Date(), body } },
        $setOnInsert: { channel: 'wix' },
      },
      { upsert: true }
    );

    res.status(200).json({ ok: true, orderNumber: doc.orderNumber });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
};
