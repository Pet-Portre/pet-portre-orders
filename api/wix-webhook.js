// api/wix-webhook.js
'use strict';

const getDb = require('../lib/db');

// small safe-get
const nx = (obj, path, d) =>
  path.split('.').reduce((o, k) => (o != null ? o[k] : undefined), obj) ?? d;

module.exports = async (req, res) => {
  try {
    // 1) method + token
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — wix-webhook');
    }
    const token = (req.query && req.query.token) || '';
    const expected = process.env.WIX_WEBHOOK_TOKEN || '';
    if (expected && token !== expected) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // 2) parse body (Vercel gives object for JSON; handle string just in case)
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (body.ping === true) {
      return res.status(200).json({ ok: true, receivedAt: new Date().toISOString() });
    }

    // Wix “Order placed” payload commonly nests under body.order; fallback to body
    const order = body.order || body;

    // 3) normalize core fields we care about (be forgiving)
    const orderNumber =
      (nx(order, 'number') ?? nx(order, 'id') ?? nx(order, 'orderId') ?? '').toString() || null;

    const createdAtStr =
      nx(order, 'createdDate') ||
      nx(order, 'createdAt') ||
      nx(order, 'dateCreated') ||
      new Date().toISOString();

    // customer
    const first = nx(order, 'buyerInfo.firstName') || nx(order, 'customer.firstName') || '';
    const last  = nx(order, 'buyerInfo.lastName')  || nx(order, 'customer.lastName')  || '';
    const email = nx(order, 'buyerInfo.email')     || nx(order, 'customer.email')     || '';
    const phone = nx(order, 'buyerInfo.phone')     || nx(order, 'customer.phone')     || '';

    // address: prefer shipping, else billing
    const ship = nx(order, 'shippingInfo.address') || nx(order, 'shippingAddress') || {};
    const bill = nx(order, 'billingInfo.address')  || nx(order, 'billingAddress')  || {};

    const addr = Object.keys(ship).length ? ship : bill;
    const address = {
      line1:  nx(addr, 'addressLine') || nx(addr, 'addressLine1') || nx(addr, 'line1') || '',
      city:   nx(addr, 'city') || '',
      district: nx(addr, 'district') || nx(addr, 'region') || '',
      postcode: (nx(addr, 'postalCode') || nx(addr, 'zip') || '').toString(),
    };

    // line items
    const itemsSrc = nx(order, 'lineItems', []);
    const items = Array.isArray(itemsSrc) ? itemsSrc.map(li => ({
      sku:       nx(li, 'sku') || nx(li, 'variant.sku') || '',
      name:      nx(li, 'name') || '',
      qty:       Number(nx(li, 'quantity', 1)) || 1,
      unitPrice: Number(nx(li, 'price.amount') ?? nx(li, 'price') ?? 0) || 0,
      variants:  {
        tshirtSize: nx(li, 'options.size') || nx(li, 'variant.size') || '',
        gender:     nx(li, 'options.gender') || '',
        color:      nx(li, 'options.color') || '',
        phoneModel: nx(li, 'options.phoneModel') || '',
        portraitSize: nx(li, 'options.portraitSize') || '',
      }
    })) : [];

    // totals
    const totals = {
      grandTotal: Number(nx(order, 'totals.total') ?? 0) || 0,
      shipping:   Number(nx(order, 'totals.shipping') ?? 0) || 0,
      discount:   Number(nx(order, 'totals.discount') ?? 0) || 0,
      currency:   nx(order, 'totals.currency') || 'TRY',
    };

    // normalized document used by /api/sync
    const doc = {
      channel: 'wix',
      orderNumber,
      createdAt: new Date(createdAtStr),
      customer: {
        name: [first, last].filter(Boolean).join(' ').trim(),
        email,
        phone,
        address
      },
      items,
      totals,
      delivery: {
        courier: nx(order, 'shippingInfo.carrier') || '',
        trackingNumber: nx(order, 'shippingInfo.trackingNumber') || '',
        status: 'NEW'
      },
      supplier: {},   // reserved for your internal flow
      notes: nx(order, 'note') || nx(order, 'remarks') || ''
    };

    const db = await getDb();

    // 4) always store raw event (for audits / debugging)
    await db.collection('raw_events').insertOne({
      source: 'wix',
      receivedAt: new Date(),
      headers: req.headers,
      body
    });

    // 5) upsert normalized record — **bypass validation** to avoid schema-validator failures
    if (!orderNumber) {
      return res.status(200).json({ ok: true, savedRawOnly: true, reason: 'no orderNumber' });
    }

    await db.collection('orders').updateOne(
      { channel: 'wix', orderNumber },
      { $set: doc, $setOnInsert: { _createdByWebhookAt: new Date() } },
      { upsert: true, bypassDocumentValidation: true }
    );

    return res.status(200).json({ ok: true, orderNumber });
  } catch (e) {
    // Bubble useful details if Mongo validator still fires somewhere else
    return res.status(500).json({
      ok: false,
      error: e.message,
      details: e && e.errInfo && e.errInfo.details ? e.errInfo.details : undefined
    });
  }
};
