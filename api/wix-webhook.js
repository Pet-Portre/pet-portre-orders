// api/wix-webhook.js  (CommonJS)
const { getClient } = require('../lib/db');

const TOKEN = process.env.WIX_WEBHOOK_TOKEN;

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — wix-webhook');
    }

    const token = (req.query.token || '').trim();
    if (!TOKEN || token !== TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ ok:false, error:'Invalid JSON' }); }
    }
    if (!body || typeof body !== 'object') return res.status(400).json({ ok:false, error:'Empty body' });

    const order = body.order || body;

    const doc = {
      channel: String(order.channel || process.env.APP_CHANNEL_DEFAULT || 'wix').toLowerCase(),
      orderNumber: String(order.number || order.orderNumber || '').trim(),
      _createdByWebhookAt: new Date(),
      createdAt: order.createdAt ? new Date(order.createdAt) : new Date(),
      customer: {
        name: order.customer?.name || [order.buyerInfo?.firstName, order.buyerInfo?.lastName].filter(Boolean).join(' ') || '',
        email: order.customer?.email || order.buyerInfo?.email || '',
        phone: order.customer?.phone || order.buyerInfo?.phone || ''
      },
      items: Array.isArray(order.items || order.lineItems)
        ? (order.items || order.lineItems).map(it => ({
            sku: it.sku || it.code || '',
            name: it.name || it.title || '',
            qty: Number(it.qty || it.quantity || 0),
            unitPrice: Number(it.unitPrice || it.price?.amount || it.price || 0)
          }))
        : [],
      totals: {
        total: Number(order.totals?.total ?? order.total ?? 0),
        shipping: Number(order.totals?.shipping ?? order.shipping ?? 0),
        discount: Number(order.totals?.discount ?? order.discount ?? 0),
        currency: order.totals?.currency || order.currency || 'TRY'
      },
      notes: order.notes || order.note || ''
    };

    if (!doc.orderNumber) return res.status(400).json({ ok:false, error:'order.number missing' });

    const client = await getClient();
    const dbName = process.env.MONGODB_DB || 'pet-portre';
    const r = await client.db(dbName).collection('orders').insertOne(doc);

    return res.status(200).json({ ok:true, orderNumber: doc.orderNumber, db: dbName, _id: r.insertedId });
  } catch (err) {
    console.error('wix-webhook crash:', err);
    return res.status(500).json({ ok:false, error: err.message || String(err) });
  }
};
