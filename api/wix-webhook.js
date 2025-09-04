// api/wix-webhook.js
// Saves minimal order doc into Mongo (DB name from MONGODB_DB, collection: 'orders')
const { getDb } = require('../lib/db'); // <= our lightweight native driver helper

async function readRawBody(req) {
  if (req.body) return req.body; // Vercel often gives string/object already
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function coerceJson(x) {
  if (!x) return {};
  if (typeof x === 'object') return x;
  try { return JSON.parse(x); } catch { return {}; }
}

function pickOrder(payload) {
  // Accept {order:{...}} or common nested Wix shapes; fall back to payload
  return (
    payload.order ||
    payload?.data?.order ||
    payload?.payload?.order ||
    payload?.entity ||
    payload
  );
}

function buildDoc(order) {
  const buyerName =
    order?.customer?.name ??
    (order?.buyerInfo
      ? `${order.buyerInfo.firstName || ''} ${order.buyerInfo.lastName || ''}`.trim()
      : '');

  const items = Array.isArray(order?.items)
    ? order.items.map(i => ({
        sku: i.sku || i.code || i.productId || '',
        name: i.name || i.title || '',
        qty: Number(i.qty ?? i.quantity ?? 1) || 1,
        unitPrice:
          Number(i.unitPrice ?? i.price?.amount ?? i.price ?? i.itemPrice?.amount ?? 0) || 0,
      }))
    : [];

  const total =
    Number(order?.totals?.total ?? order?.totalPrice?.amount ?? order?.total ?? 0) || 0;

  const currency =
    (order?.totals?.currency || order?.currency || 'TRY').toString().toUpperCase();

  return {
    channel: order?.channel || process.env.APP_CHANNEL_DEFAULT || 'wix',
    orderNumber: String(order?.number ?? order?.id ?? order?._id ?? ''),
    createdAt: order?.createdAt ? new Date(order.createdAt) : new Date(),
    customer: {
      name: buyerName || '',
      email: order?.customer?.email || order?.buyerInfo?.email || '',
      phone: order?.customer?.phone || order?.buyerInfo?.phone || '',
    },
    delivery: {
      address:
        order?.address ||
        order?.billingInfo?.address?.addressLine ||
        order?.shippingInfo?.address?.addressLine ||
        '',
      city:
        order?.city ||
        order?.billingInfo?.address?.city ||
        order?.shippingInfo?.address?.city ||
        '',
      postcode:
        order?.postalCode ||
        order?.billingInfo?.address?.postalCode ||
        order?.shippingInfo?.address?.postalCode ||
        '',
    },
    items,
    totals: { total, currency },
    notes: order?.notes || order?.note || '',
    _createdByWebhookAt: new Date(),
  };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — wix-webhook');
    }

    const token = (req.query.token || '').trim();
    if (!process.env.WIX_WEBHOOK_TOKEN || token !== process.env.WIX_WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // Parse body robustly (string | object)
    const raw = await readRawBody(req);
    const payload = coerceJson(raw);
    const order = pickOrder(payload);

    if (!order) {
      return res.status(400).json({ ok: false, error: 'no order in payload' });
    }

    const doc = buildDoc(order);
    if (!doc.orderNumber) {
      return res.status(400).json({ ok: false, error: 'missing orderNumber' });
    }

    // Lazy DB connect + upsert
    const db = await getDb(); // uses MONGODB_URI + MONGODB_DB
    const col = db.collection('orders');

    const result = await col.updateOne(
      { orderNumber: doc.orderNumber },
      {
        $set: {
          channel: doc.channel,
          createdAt: doc.createdAt,
          customer: doc.customer,
          delivery: doc.delivery,
          items: doc.items,
          totals: doc.totals,
          notes: doc.notes,
          _updatedAt: new Date(),
        },
        $setOnInsert: { _createdByWebhookAt: doc._createdByWebhookAt },
      },
      { upsert: true }
    );

    return res.status(200).json({
      ok: true,
      orderNumber: doc.orderNumber,
      upserted: Boolean(result.upsertedId),
      matched: result.matchedCount || 0,
      modified: result.modifiedCount || 0,
    });
  } catch (e) {
    console.error('wix-webhook error:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};
