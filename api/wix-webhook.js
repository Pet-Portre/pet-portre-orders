// api/wix-webhook.js
const { getDb } = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('POST only — wix-webhook');
  }

  try {
    const token = req.query.token || req.headers['x-webhook-token'];
    if (!process.env.WIX_WEBHOOK_TOKEN || token !== process.env.WIX_WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Unauthorized (token mismatch)' });
    }

    const body = req.body && Object.keys(req.body).length ? req.body : {};
    // Accept either { order: {...} } or the order object itself
    const src = body.order || body;

    // Minimal mapping so even partial payloads work
    const orderNumber = String(src.number || src.orderNumber || '').trim();
    if (!orderNumber) {
      return res.status(400).json({ ok: false, error: 'Missing order.number' });
    }

    const doc = {
      channel: src.channel || 'wix',
      orderNumber,
      createdAt: src.createdAt ? new Date(src.createdAt) : new Date(),
      customer: {
        name: src.customer?.name || [src.buyerInfo?.firstName, src.buyerInfo?.lastName].filter(Boolean).join(' '),
        email: src.customer?.email || src.buyerInfo?.email,
        phone: src.customer?.phone || src.buyerInfo?.phone
      },
      delivery: {
        address: src.address || src.billingInfo?.address?.addressLine || '',
        city: src.city || src.billingInfo?.address?.city || '',
        postcode: src.postcode || src.billingInfo?.address?.postalCode || ''
      },
      items: Array.isArray(src.items) ? src.items : (Array.isArray(src.lineItems) ? src.lineItems : []),
      totals: src.totals || { total: src.total || 0, currency: (src.currency || 'TRY') },
      notes: src.notes || src.note || '',
      _createdByWebhookAt: new Date()
    };

    const db = await getDb();
    const col = db.collection('orders');

    const r = await col.updateOne(
      { orderNumber: doc.orderNumber },
      { $set: doc, $setOnInsert: { _firstSeenAt: new Date() } },
      { upsert: true }
    );

    return res.json({
      ok: true,
      orderNumber: doc.orderNumber,
      upserted: !!r.upsertedId,
      matched: r.matchedCount,
      modified: r.modifiedCount
    });
  } catch (e) {
    console.error('[wix-webhook] error:', e);
    return res.status(500).json({
      ok: false,
      error: e.message,
      name: e.name,
      code: e.code,
      hint: 'Hit /api/db-ping to verify DB; ensure package.json has mongodb and envs are set'
    });
  }
};
