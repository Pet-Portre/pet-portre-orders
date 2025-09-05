// api/wix-webhook.js
const { withDb } = require('../lib/db');

const getToken = (req) =>
  (req.query && req.query.token) ||
  req.headers['x-api-key'] ||
  (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

const asObject = (b) => {
  if (!b) return {};
  if (typeof b === 'object') return b;
  try { return JSON.parse(b); } catch { return {}; }
};
const truthy = (v) => v === true || v === 'true' || v === 1 || v === '1';

const pick = (obj, path) =>
  path.split('.').reduce((a, k) => (a && a[k] != null ? a[k] : undefined), obj);

const buildDoc = (p) => {
  const orderNumber = p['Order number'] || pick(p, 'order.number') || p.id || '';
  const createdAt   = p['Date created'] || new Date().toISOString();

  const name = p['Contact name'] ||
    [p['Shipping destination contact first name'], p['Shipping destination contact last name']]
      .filter(Boolean).join(' ').trim();

  const email   = p['Customer email'] || p['Contact email'] || '';
  const phone   = p['Shipping destination contact phone number'] || p['Contact phone'] || '';
  const fullAdr = p['Shipping formatted address'] ||
    [p['Shipping address line'], p['Shipping address line 2'], p['Shipping address city'],
     p['Shipping address subdivision'], p['Shipping address ZIP/postal code'],
     p['Shipping address country']].filter(Boolean).join(', ');

  const items = Array.isArray(p['Ordered items']) ? p['Ordered items'] : [];
  const it0   = items[0] || {};
  const qty   = Number(it0['Ordered item quantity'] || 1) || 1;
  const total = Number(it0['Ordered item total price value'] || 0) || 0;
  let unit    = Number(it0['Ordered item price before tax value'] || 0);
  if (!unit && qty) unit = Number((total / qty).toFixed(2));
  const currency = it0['Ordered item total price currency'] || p['Order total currency'] || 'TRY';

  return {
    channel: 'wix',
    orderNumber,
    createdAt,
    customer: {
      name: name || '',
      email,
      phone,
      address: fullAdr,
      city: p['Shipping address city'] || '',
      district: p['Shipping address subdivision'] || '',
      postcode: p['Shipping address ZIP/postal code'] || ''
    },
    items: it0 && Object.keys(it0).length ? [{
      sku: it0['Ordered item SKU'] || '',
      name: it0['Ordered item name'] || '',
      quantity: qty,
      unitPrice: unit,
      lineTotal: total,
      currency
    }] : [],
    totals: {
      total: Number(p['Order total value'] || total) || 0,
      discount: Number(p['Discount amount value'] || 0) || 0,
      shipping: Number(p['Shipping amount value'] || p['Order total shipping amount value'] || 0) || 0,
      currency
    },
    notes: ''
  };
};

module.exports = async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST, OPTIONS');
      return res.status(405).json({ ok: false, error: 'POST only' });
    }

    // auth
    const token = getToken(req);
    if (!process.env.WIX_WEBHOOK_TOKEN || token !== process.env.WIX_WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const body = asObject(req.body);

    // tolerant ping (accepts true or "true", query or body)
    if (truthy(body.ping) || truthy(req.query.ping)) {
      return res.status(200).json({ ok: true, pong: true });
    }

    // build doc and upsert
    let doc = buildDoc(body);
    if (!doc.orderNumber) {
      doc.orderNumber = 'WIX-' + Date.now();
      doc.notes = 'Temp ID: payload had no order number';
    }

    const writeEnabled = String(process.env.MONGODB_WRITE_ENABLED || '').toLowerCase() === 'true';
    if (!writeEnabled) return res.status(200).json({ ok: true, dryRun: true, doc });

    await withDb(async (db) => {
      await db.collection('orders').updateOne(
        { channel: 'wix', orderNumber: doc.orderNumber },
        { $setOnInsert: { _firstSeenAt: new Date() }, $set: { ...doc, _createdByWebhookAt: new Date() } },
        { upsert: true }
      );
    });

    return res.status(200).json({ ok: true, orderNumber: doc.orderNumber });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
