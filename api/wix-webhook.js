// api/wix-webhook.js
// Receives Wix "Order placed" webhooks (or your CLI tests) and upserts into MongoDB.

const { withDb } = require('../lib/db'); // must export withDb(dbTask)

module.exports = async (req, res) => {
  try {
    // --- method guard ---
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — wix-webhook');
    }

    // --- auth (token can be in query ?token= or header x-api-key) ---
    const token =
      (req.query && req.query.token) ||
      req.headers['x-api-key'] ||
      '';
    if (!process.env.WIX_WEBHOOK_TOKEN || token !== process.env.WIX_WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // --- robust body parsing (handles Buffer, string, object) ---
    let body = req.body;
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') {
      try { body = JSON.parse(body); }
      catch { return res.status(400).json({ ok:false, error:'Invalid JSON' }); }
    }
    body = (body && typeof body === 'object') ? body : {};

    // --- health check (CLI) ---
    if (body.ping) {
      return res.json({ ok: true, pong: true });
    }

    // --- accept minimal order payload (what we use from Wix/CLI) ---
    // Expect body like:
    // {
    //   "order": { "number": "10046", "createdAt": "2025-09-04T20:19:04.273Z", "channel": "wix" },
    //   "customer": { "name": "...", "email": "...", "phone": "..." },
    //   "items":    [ { "sku":"...", "name":"...", "qty":1, "unitPrice":90 } ],
    //   "totals":   { "total":90, "currency":"TRY" },
    //   "notes":    "..."
    // }
    const order = body.order || {};
    if (!order.number) {
      return res.status(400).json({ ok:false, error:'Missing order.number' });
    }

    // Normalize document to store
    const doc = {
      orderNumber: String(order.number),
      channel: order.channel || 'wix',
      createdAt: order.createdAt ? new Date(order.createdAt) : new Date(),

      // these can be top-level in our incoming payload
      customer: body.customer || body.buyerInfo || {},
      items: body.items || body.lineItems || [],
      totals: body.totals || body.orderTotals || {},
      notes: body.notes || '',

      _createdByWebhookAt: new Date()
    };

    // --- upsert into Mongo ---
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

    return res.json({
      ok: true,
      orderNumber: doc.orderNumber,
      upserted: result.upsertedCount === 1,
      matched: result.matchedCount || 0,
      modified: result.modifiedCount || 0
    });
  } catch (err) {
    // Surface a concise error (and keep details out of the response).
    res.status(500).json({ ok:false, error: err.message });
  }
};
