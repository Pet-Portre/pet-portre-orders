// api/wix-webhook.js
'use strict';

// tiny safe getter
const nx = (o, p, d) => p.split('.').reduce((x, k) => (x != null ? x[k] : undefined), o) ?? d;

// lazy Mongo connection (no top-level require)
let _dbPromise;
async function getDb() {
  if (!_dbPromise) {
    const { MongoClient } = require('mongodb'); // loaded only when needed
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI missing');
    const client = new MongoClient(uri, { maxPoolSize: 4 });
    _dbPromise = client.connect().then(c => c.db(process.env.MONGODB_DB || 'pet-portre'));
  }
  return _dbPromise;
}

module.exports = async (req, res) => {
  try {
    // 1) Method + token
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — wix-webhook');
    }
    const expected = process.env.WIX_WEBHOOK_TOKEN || '';
    const token = (req.query && req.query.token) || '';
    if (expected && token !== expected) return res.status(401).json({ ok: false, error: 'unauthorized' });

    // 2) Body
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (body.ping === true) return res.status(200).json({ ok: true, receivedAt: new Date().toISOString() });

    const order = body.order || body;

    // 3) Normalize a few fields (very forgiving)
    const orderNumber = (nx(order, 'number') ?? nx(order, 'id') ?? nx(order, 'orderId') ?? '').toString();
    const createdAtStr = nx(order, 'createdDate') || nx(order, 'createdAt') || new Date().toISOString();

    const first = nx(order, 'buyerInfo.firstName') || nx(order, 'customer.firstName') || '';
    const last  = nx(order, 'buyerInfo.lastName')  || nx(order, 'customer.lastName')  || '';
    const email = nx(order, 'buyerInfo.email')     || nx(order, 'customer.email')     || '';
    const phone = nx(order, 'buyerInfo.phone')     || nx(order, 'customer.phone')     || '';

    const ship = nx(order, 'shippingInfo.address') || nx(order, 'shippingAddress') || {};
    const bill = nx(order, 'billingInfo.address')  || nx(order, 'billingAddress')  || {};
    const addr = Object.keys(ship).length ? ship : bill;

    const address = {
      line1: nx(addr, 'addressLine') || nx(addr, 'addressLine1') || nx(addr, 'line1') || '',
      city: nx(addr, 'city') || '',
      district: nx(addr, 'district') || nx(addr, 'region') || '',
      postcode: (nx(addr, 'postalCode') || nx(addr, 'zip') || '').toString(),
    };

    const items = Array.isArray(nx(order, 'lineItems', []))
      ? nx(order, 'lineItems', []).map(li => ({
          sku: nx(li, 'sku') || nx(li, 'variant.sku') || '',
          name: nx(li, 'name') || '',
          qty: Number(nx(li, 'quantity', 1)) || 1,
          unitPrice: Number(nx(li, 'price.amount') ?? nx(li, 'price') ?? 0) || 0,
          variants: {
            tshirtSize: nx(li, 'options.size') || nx(li, 'variant.size') || '',
            gender: nx(li, 'options.gender') || '',
            color: nx(li, 'options.color') || '',
            phoneModel: nx(li, 'options.phoneModel') || '',
            portraitSize: nx(li, 'options.portraitSize') || '',
          }
        }))
      : [];

    const totals = {
      grandTotal: Number(nx(order, 'totals.total') ?? 0) || 0,
      shipping: Number(nx(order, 'totals.shipping') ?? 0) || 0,
      discount: Number(nx(order, 'totals.discount') ?? 0) || 0,
      currency: nx(order, 'totals.currency') || 'TRY',
    };

    const doc = {
      channel: 'wix',
      orderNumber: orderNumber || null,
      createdAt: new Date(createdAtStr),
      customer: { name: [first, last].filter(Boolean).join(' ').trim(), email, phone, address },
      items,
      totals,
      delivery: {
        courier: nx(order, 'shippingInfo.carrier') || '',
        trackingNumber: nx(order, 'shippingInfo.trackingNumber') || '',
        status: 'NEW'
      },
      supplier: {},
      notes: nx(order, 'note') || nx(order, 'remarks') || ''
    };

    const db = await getDb();

    // Always keep raw event for debugging
    await db.collection('raw_events').insertOne({
      source: 'wix',
      receivedAt: new Date(),
      headers: req.headers,
      body
    });

    // If no order number, save raw only (don’t fail)
    if (!orderNumber) {
      return res.status(200).json({ ok: true, savedRawOnly: true, reason: 'no orderNumber' });
    }

    // Upsert normalized order; bypass collection validator
    await db.collection('orders').updateOne(
      { channel: 'wix', orderNumber },
      { $set: doc, $setOnInsert: { _createdByWebhookAt: new Date() } },
      { upsert: true, bypassDocumentValidation: true }
    );

    return res.status(200).json({ ok: true, orderNumber });
  } catch (e) {
    console.error('wix-webhook error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
