// api/wix-webhook.js
// Tolerant Wix webhook -> Mongo upsert (with phone mapping)

const { withDb } = require('../lib/db');
const qs = require('querystring');

function pickPhone(raw) {
  const p =
    raw?.shippingInfo?.shippingDestination?.contactDetails?.phone ||
    raw?.billingInfo?.contactDetails?.phone ||
    raw?.contact?.phone ||
    raw?.buyerInfo?.phone ||
    '';
  const digits = String(p).replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.length === 11 && digits.startsWith('0')) return digits;           // 0XXXXXXXXXX
  if (digits.length === 10) return '0' + digits;                               // XXXXXXXXXX -> 0XXXXXXXXXX
  if (digits.length === 12 && digits.startsWith('90')) return '0' + digits.slice(2); // 90XXXXXXXXXX -> 0XXXXXXXXXX
  return digits;
}

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
      try { body = JSON.parse(body); }
      catch {
        const maybe = qs.parse(body);
        const onlyKey = Object.keys(maybe)[0];
        try { body = JSON.parse(maybe[onlyKey]); } catch { body = maybe; }
      }
    }
    body = body || {};

    // quick ping
    if (body.ping === true) return res.json({ ok: true, pong: true });

    // --- normalize incoming shapes ---
    const raw =
      body.order ||
      body.data?.order ||
      body.data ||
      body.payload?.order ||
      body.payload ||
      body;

    // order number candidates
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

    // map common fields (permissive)
    const doc = {
      orderNumber: String(orderNumber),
      channel: raw?.channel || raw?.channelType || 'wix',
      createdAt,
      customer: raw?.buyerInfo || raw?.customer || body.customer || {},
      items: raw?.lineItems || raw?.items || [],
      totals: raw?.totals || raw?.orderTotals || raw?.priceSummary || {},
      notes: raw?.notes || body.notes || '',
      _createdByWebhookAt: new Date()
    };

    // ensure customer.phone is populated
    const phone = pickPhone(raw);
    if (phone) {
      doc.customer = { ...(doc.customer || {}), phone };
    }
    // try to keep email if visible at top-level payload
    if (!doc.customer?.email) {
      const email = raw?.buyerEmail || raw?.contact?.email || '';
      if (email) doc.customer.email = email;
    }

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
