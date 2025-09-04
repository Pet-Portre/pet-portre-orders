// File: api/wix-webhook.js
const { withDb } = require('../lib/db');

const pick = (obj, path, dflt) =>
  path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj) ?? dflt;

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — wix-webhook');
    }

    // auth
    const token = req.query.token || req.headers['x-api-key'] || '';
    if (!process.env.WIX_WEBHOOK_TOKEN || token !== process.env.WIX_WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // parse body
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ ok:false, error:'Invalid JSON' }); }
    }
    body = body || {};

    // simple ping
    if (body.ping) return res.json({ ok: true, pong: true });

    // allow { order: {...} } or flattened
    const order = body.order || body || {};
    const number = String(order.number || order.orderNumber || '').trim();
    if (!number) return res.status(400).json({ ok:false, error:'Missing order.number' });

    // buyer/customer
    const customer =
      body.customer ||
      body.buyerInfo || {
        firstName: pick(body, 'buyerInfo.firstName', ''),
        lastName:  pick(body, 'buyerInfo.lastName', ''),
        email:     pick(body, 'buyerInfo.email', ''),
        phone:     pick(body, 'buyerInfo.phone', ''),
      };

    // addresses (best-effort)
    const delivery = body.delivery || body.shippingInfo || {
      address: {
        line1: pick(body, 'billingInfo.address.addressLine', ''),
        city:  pick(body, 'billingInfo.address.city', ''),
        postalCode: pick(body, 'billingInfo.address.postalCode', ''),
        country: pick(body, 'billingInfo.address.country', ''),
      }
    };

    // items (supports many shapes)
    let rawItems =
      body.items ||
      body.lineItems ||
      pick(body, 'order.lineItems', []) ||
      [];

    if (!Array.isArray(rawItems)) rawItems = [rawItems];

    const items = rawItems.map((it) => {
      const unitPrice =
        Number(pick(it, 'price.amount', it.unitPrice ?? it.price ?? 0)) || 0;
      const qty = Number(it.quantity ?? it.qty ?? 1);
      return {
        sku: it.sku || it.code || '',
        name: it.name || it.title || '',
        qty,
        unitPrice,
        currency: pick(it, 'price.currency', body.currency || 'TRY'),
      };
    });

    // totals (fallback compute)
    const totals = body.totals || body.orderTotals || (() => {
      const total = items.reduce((s, i) => s + i.unitPrice * i.qty, 0);
      const currency = (items[0] && items[0].currency) || body.currency || 'TRY';
      return { total, currency, shipping: 0, discount: 0 };
    })();

    // normalize doc
    const doc = {
      orderNumber: number,
      channel: order.channel || 'wix',
      createdAt: order.createdAt
        ? new Date(order.createdAt)
        : new Date(pick(order, 'createdDate', Date.now())),
      customer,
      delivery,
      items,
      totals,
      notes: body.notes || '',
      _createdByWebhookAt: new Date()
    };

    const result = await withDb(async (db) => {
      const col = db.collection('orders');
      return col.updateOne(
        { orderNumber: doc.orderNumber },                       // idempotent on order number
        {
          $setOnInsert: { orderNumber: doc.orderNumber, channel: doc.channel, createdAt: doc.createdAt },
          $set: {
            customer: doc.customer,
            delivery: doc.delivery,
            items: doc.items,
            totals: doc.totals,
            notes: doc.notes,
            _createdByWebhookAt: doc._createdByWebhookAt
          }
        },
        { upsert: true }
      );
    });

    res.json({
      ok: true,
      orderNumber: doc.orderNumber,
      upserted: result.upsertedCount === 1,
      matched: result.matchedCount,
      modified: result.modifiedCount
    });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
};
