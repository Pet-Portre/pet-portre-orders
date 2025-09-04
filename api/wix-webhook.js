// api/wix-webhook.js
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME     = process.env.MONGODB_DB || 'pet-portre';
const TOKEN       = process.env.WIX_WEBHOOK_TOKEN;

let clientPromise;
function getClient() {
  if (!clientPromise) clientPromise = new MongoClient(MONGODB_URI).connect();
  return clientPromise;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only');
    }
    if (!TOKEN || req.query.token !== TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (body.ping) return res.status(200).json({ ok: true, receivedAt: new Date().toISOString() });

    const db = (await getClient()).db(DB_NAME);

    // 1) keep the full raw event
    await db.collection('raw_events').insertOne({
      source: 'wix',
      receivedAt: new Date(),
      body
    });

    // 2) extract order-ish fields (works with typical Wix payloads)
    const o = body.order || body.data || body;
    const orderNumber = (o.number || o.orderNumber || o._id || '').toString();
    const createdAt = new Date(o.createdDate || o.createdAt || Date.now());

    const buyer  = o.buyerInfo || o.customer || {};
    const addr   =
      (o.billingInfo && o.billingInfo.address) ||
      (o.shippingInfo && o.shippingInfo.address) || {};

    const items = (o.lineItems || o.items || []).map(it => ({
      sku: it.sku || it.catalogReference?.catalogItemId || '',
      name: it.name || it.productName || '',
      qty: Number(it.quantity || it.qty || 1),
      unitPrice: Number(it.price?.amount ?? it.unitPrice ?? it.price ?? 0)
    }));

    const totals = {
      grandTotal: Number(o.totals?.total ?? o.total ?? 0),
      shipping:   Number(o.totals?.shipping ?? o.shipping ?? 0),
      discount:   Number(o.totals?.discount ?? 0),
      currency:   o.currency || o.totals?.currency || 'TRY'
    };

    const doc = {
      channel: 'wix',
      orderNumber,
      createdAt,
      customer: {
        name: [buyer.firstName, buyer.lastName].filter(Boolean).join(' ') || buyer.name || '',
        email: buyer.email || '',
        phone: buyer.phone || '',
        address: {
          line1: addr.addressLine || addr.address1 || addr.streetAddress || '',
          city:  addr.city || '',
          postcode: addr.postalCode || addr.zip || ''
        }
      },
      items,
      totals,
      updatedAt: new Date()
    };

    // 3) upsert order (if we can identify it), otherwise raw-only
    if (!orderNumber) {
      return res.status(200).json({ ok: true, note: 'saved raw only (no orderNumber)' });
    }

    await db.collection('orders').updateOne(
      { channel: 'wix', orderNumber },
      { $set: doc, $setOnInsert: { createdByWebhookAt: new Date() } },
      { upsert: true }
    );

    return res.status(200).json({ ok: true, orderNumber });
  } catch (e) {
    console.error('wix-webhook error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
