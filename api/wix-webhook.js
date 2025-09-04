// api/wix-webhook.js
// Tolerant Wix webhook -> Mongo upsert

const { withDb } = require('../lib/db');
const qs = require('querystring');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — wix-webhook');
    }

    // --- auth (supports ?token=, x-api-key, Authorization: Bearer) ---
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const token =
      req.query.token ||
      req.headers['x-api-key'] ||
      bearer ||
      '';
    if (!process.env.WIX_WEBHOOK_TOKEN || token !== process.env.WIX_WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // --- body parsing (json or urlencoded or raw string) ---
    let body = req.body;
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string' && body.trim()) {
      // try JSON first, then x-www-form-urlencoded
      try { body = JSON.parse(body); }
      catch {
        const maybe = qs.parse(body);
        // if parsing produced a single key with JSON value, unwrap it
        const onlyKey = Object.keys(maybe)[0];
        try { body = JSON.parse(maybe[onlyKey]); } catch { body = maybe; }
      }
    }
    body = body || {};

    // quick ping
    if (body.ping === true) return res.json({ ok: true, pong: true });

    // --- normalize incoming shapes ---
    // Wix Automations can send:
    // { order:{...} }  OR  { data:{...} }  OR  { payload:{ order:{...} }}  OR flat { ... }
    const raw =
      body.order ||
      body.data?.order ||
      body.data ||
      body.payload?.order ||
      body.payload ||
      body;

    // Try many candidate fields for the order number/id
    const orderNumber =
      raw?.number ??
      raw?.orderNumber ??
      raw?.id ??
      raw?._id ??
      raw?.orderId ??
      raw?.reference ??
      raw?.reference_number ??
      raw?.referenceNumber ??
      null;

    if (!orderNumber) {
      // minimal diagnostics that won't leak payload
      return res.status(400).json({ ok: false, error: 'Missing order.number' });
    }

    // created time candidates
    const createdAtStr =
      raw?.createdAt ??
      raw?.createdDate ??
      raw?.created_time ??
      body?.eventTime ??
      null;

    const createdAt = createdAtStr ? new Date(createdAtStr) : new Date();

    // map common fields (stay permissive)
    const doc = {
      orderNumber: String(orderNumber),
      channel: raw?.channel || 'wix',
      createdAt,
      customer: raw?.buyerInfo || raw?.customer || body.customer || {},
      items: raw?.lineItems || raw?.items || [],
      totals: raw?.totals || raw?.orderTotals || {},
      notes: raw?.notes || body.notes || '',
      _createdByWebhookAt: new Date()
    };

    // --- upsert ---
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
      matched: result.matchedCount,
      modified: result.modifiedCount
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
