// api/wix-webhook.js
const { withDb } = require('../lib/db');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — wix-webhook');
    }

    const token =
      (req.query && req.query.token) ||
      req.headers['x-api-key'] ||
      '';
    if (!process.env.WIX_WEBHOOK_TOKEN || token !== process.env.WIX_WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // Robust body parsing
    let body = req.body;
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ ok:false, error:'Invalid JSON' }); }
    }
    body = body && typeof body === 'object' ? body : {};

    if (body.ping) return res.json({ ok: true, pong: true });

    const order = body.order || {};
    if (!order.number) return res.status(400).json({ ok:false, error:'Missing order.number' });

    const doc = {
      orderNumber: String(order.number),
      channel: order.channel || 'wix',
      createdAt: order.createdAt ? new Date(order.createdAt) : new Date(),
      customer: body.customer || body.buyerInfo || {},
      items: body.items || body.lineItems || [],
      totals: body.totals || body.orderTotals || {},
      notes: body.notes || '',
      _createdByWebhookAt: new Date()
    };

    const result = await withDb(async (db) => {
      const col = db.collection('orders');
      return col.updateOne(
        { orderNumber: doc.orderNumber },
        {
          $setOnInsert: {
            orderNumber: doc.orderNumber,
            channel: doc.channel,
            createdAt: doc.createdAt
          },
          $set: {
            customer: doc.customer,
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
      matched: result.matchedCount || 0,
      modified: result.modifiedCount || 0
    });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
};
