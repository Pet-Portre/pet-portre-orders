// File: api/wix-webhook.js
const { getDb } = require('../lib/db');

const TOKEN = process.env.WIX_WEBHOOK_TOKEN; // query ?token=... or header x-api-key

function asObj(b) {
  if (!b) return {};
  if (typeof b === 'object') return b;
  try { return JSON.parse(b); } catch { return {}; }
}

function pickOrder(body) {
  // Accept our minimal body: { order: { number, ... } }
  if (body?.order && (body.order.number || body.order.orderNumber)) return body.order;

  // Common Wix shapes
  if (body?.data?.order && (body.data.order.number || body.data.order.orderNumber)) return body.data.order;
  if (body?.order && typeof body.order === 'object') return body.order;

  // Raw Wix order object at top level (has "number")
  if (body?.number) return body;

  // Sometimes wrapped in "entity"/"entities"
  if (Array.isArray(body?.entities)) {
    const e = body.entities.find(x => x?.number || x?.order?.number);
    if (e?.order) return e.order;
    if (e) return e;
  }

  return null;
}

function mapDoc(order, body) {
  const num = order.number ?? order.orderNumber;
  const created =
    body?.createdAt ||
    order.createdAt ||
    order.createdDate ||
    order.dateCreated ||
    new Date().toISOString();

  // Try to normalize some common fields
  const items = order.items || order.lineItems || [];
  const totals =
    order.totals ||
    { total: order.total ?? order.amountTotal ?? 0, currency: order.currency || 'TRY' };

  const customer =
    order.customer ||
    order.buyerInfo ||
    (order.billingInfo?.fullName ? { name: order.billingInfo.fullName } : undefined) ||
    {};

  return {
    channel: body.channel || order.channel || 'wix',
    orderNumber: String(num),
    createdAt: new Date(created),
    customer,
    items,
    totals,
    notes: order.notes || body.notes || '',
    _createdByWebhookAt: new Date(),
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('POST only — wix-webhook');
  }

  // Token check (query or header)
  const tokenOk =
    !TOKEN || req.query.token === TOKEN || req.headers['x-api-key'] === TOKEN;
  if (!tokenOk) return res.status(401).json({ ok: false, error: 'Bad token' });

  const body = asObj(req.body);

  // Ping path for quick tests: {"ping":true}
  if (body.ping) return res.status(200).json({ ok: true, pong: true });

  const order = pickOrder(body);
  if (!order || !(order.number || order.orderNumber)) {
    // Help debug without dumping the whole payload
    const keys = Object.keys(body || {}).slice(0, 12);
    return res.status(400).json({
      ok: false,
      error: 'Missing order.number',
      hint: 'Send minimal { order: { number, ... } } or Wix full order payload.',
      keys,
    });
  }

  try {
    const doc = mapDoc(order, body);
    const db = await getDb();
    const col = db.collection('orders');

    const result = await col.updateOne(
      { orderNumber: doc.orderNumber },
      { $set: doc },
      { upsert: true }
    );

    return res.status(200).json({
      ok: true,
      orderNumber: doc.orderNumber,
      upserted: !!result.upsertedCount,
      matched: result.matchedCount,
      modified: result.modifiedCount,
    });
  } catch (e) {
    console.error('wix-webhook error:', e?.message);
    return res.status(500).json({ ok: false, error: e?.message || 'server error' });
  }
};
