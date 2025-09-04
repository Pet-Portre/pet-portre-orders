// File: api/wix-webhook.js
const { getDb, connectDB } = require('../lib/db');

function getOrderNumber(b) {
  return (
    b?.order?.number ??
    b?.order?.orderNumber ??
    b?.number ??
    b?.orderNumber ??
    b?.data?.order?.number ??
    b?.entity?.order?.number ??
    b?.entity?.number ??
    null
  );
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('POST only — wix-webhook');
  }

  // Token check
  const token = req.query.token || req.headers['x-api-key'];
  if (!process.env.WIX_WEBHOOK_TOKEN || token !== process.env.WIX_WEBHOOK_TOKEN) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // Parse body (Vercel already parses JSON; be defensive)
  const body = typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});

  try {
    await connectDB();
    const db = await getDb();

    // Always archive the raw event so nothing is ever lost
    await db.collection('raw_events').insertOne({
      receivedAt: new Date(),
      query: req.query,
      headers: req.headers,
      body
    });

    const orderNumber = getOrderNumber(body);
    if (!orderNumber) {
      // Don’t fail the hook; acknowledge but indicate queued
      return res.status(202).json({ ok: true, queued: true, reason: 'order.number not found; raw saved' });
    }

    // Build a lean doc from whatever fields are present
    const order = body.order || body;
    const doc = {
      orderNumber: String(orderNumber),
      channel: order.channel || body.channel || 'wix',
      createdAt: order.createdAt ? new Date(order.createdAt) : new Date(),
      customer: {
        name: order.customer?.name || [order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ') || '',
        email: order.customer?.email || '',
        phone: order.customer?.phone || ''
      },
      address: order.address || order.billingInfo?.address || {},
      items: (order.items || order.lineItems || []).map(i => ({
        sku: i.sku || i.id || '',
        name: i.name || i.title || '',
        qty: Number(i.qty || i.quantity || 1),
        unitPrice: Number(i.unitPrice || i.price?.amount || i.price || 0)
      })),
      totals: order.totals || {
        total: Number(order.total || body.totals?.total || 0),
        currency: order.currency || body.currency || 'TRY'
      },
      notes: order.notes || order.note || ''
    };

    const r = await db.collection('orders').updateOne(
      { orderNumber: doc.orderNumber },
      { $setOnInsert: { createdByWebhookAt: new Date() }, $set: doc },
      { upsert: true }
    );

    return res.status(200).json({
      ok: true,
      orderNumber: doc.orderNumber,
      upserted: Boolean(r.upsertedId),
      matched: r.matchedCount,
      modified: r.modifiedCount
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
