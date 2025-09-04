// api/wix-webhook.js
const { withDb } = require('../lib/db');

function pick(v, path, dflt = undefined) {
  try {
    return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), v) ?? dflt;
  } catch { return dflt; }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — wix-webhook');
    }

    // token: allow query ?token=… OR header x-api-key
    const token = req.query.token || req.headers['x-api-key'] || '';
    if (!process.env.WIX_WEBHOOK_TOKEN || token !== process.env.WIX_WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // body may already be object (Wix) or stringified
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ ok:false, error:'Invalid JSON' }); }
    }
    body = body || {};

    // health ping
    if (body.ping) return res.json({ ok: true, pong: true });

    // Support BOTH: your minimal {order, customer, items, totals, notes}
    // AND Wix "entire payload" from the Order Placed trigger.
    const isWix = !!(body._id || body.number || body.buyerInfo || body.lineItems || body.totals);

    const orderNumber = isWix
      ? String(body.number || body.orderNumber || '')
      : String(pick(body, 'order.number', ''));

    if (!orderNumber) return res.status(400).json({ ok:false, error:'Missing order.number' });

    const createdAt = isWix
      ? new Date(body._createdDate || body.createdDate || Date.now())
      : (pick(body, 'order.createdAt') ? new Date(body.order.createdAt) : new Date());

    const buyer = isWix ? (body.buyerInfo || {}) : (body.customer || body.buyerInfo || {});
    const billingAddr = isWix ? pick(body, 'billingInfo.address', {}) : (body.address || {});
    const shippingAddr = isWix ? pick(body, 'shippingInfo.address', {}) : (body.address || {});
    const totals = isWix ? (body.totals || {}) : (body.totals || {});
    const currency = (
      pick(totals, 'total.currency') ||
      pick(body, 'currency') ||
      pick(totals, 'currency') ||
      'TRY'
    );

    const lineItems = isWix ? (body.lineItems || []) : (body.items || body.lineItems || []);
    const items = lineItems.map(li => ({
      sku: li.sku || li.catalogReferenceId || '',
      name: li.name || '',
      qty: Number(li.quantity || li.qty || 0),
      unitPrice: Number(pick(li, 'price.amount', li.unitPrice || 0)),
    }));

    const doc = {
      orderNumber,
      channel: (isWix ? 'wix' : (body.channel || 'wix')),
      createdAt,
      customer: {
        firstName: buyer.firstName || pick(buyer, 'name', '').split(' ')[0] || '',
        lastName:  buyer.lastName  || (pick(buyer, 'name', '').split(' ').slice(1).join(' ') || ''),
        name:      [buyer.firstName, buyer.lastName].filter(Boolean).join(' ') || pick(buyer,'name',''),
        email:     buyer.email || '',
        phone:     buyer.phone || '',
      },
      address: {
        line1:  pick(billingAddr, 'streetAddress.name') || billingAddr.street || billingAddr.streetAddress || pick(shippingAddr,'streetAddress.name') || '',
        line2:  pick(billingAddr, 'addressLine2') || '',
        city:   billingAddr.city || pick(billingAddr,'subdivision') || '',
        postalCode: billingAddr.postalCode || billingAddr.zip || '',
        country: billingAddr.country || billingAddr.countryCode || 'TR',
      },
      items,
      totals: {
        total: Number(pick(totals, 'total.amount', totals.total || 0)),
        currency,
      },
      notes: body.notes || body.message || '',
      _createdByWebhookAt: new Date()
    };

    const result = await withDb(async (db) => {
      const col = db.collection('orders');
      return col.updateOne(
        { orderNumber: doc.orderNumber },
        {
          $setOnInsert: { orderNumber: doc.orderNumber, channel: doc.channel, createdAt: doc.createdAt },
          $set: {
            customer: doc.customer,
            address: doc.address,
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
