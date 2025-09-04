// Minimal Wix → MongoDB webhook (POST only)
const { getDb } = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('POST only — wix-webhook');
  }

  try {
    // simple shared secret (either ?token= or x-api-key)
    const token = String(req.query.token || req.headers['x-api-key'] || '');
    const required = process.env.WIX_WEBHOOK_TOKEN || '';
    if (required && token !== required) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // handle raw JSON string bodies safely
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* ignore */ }
    }
    body = body || {};

    // health ping support
    if (body.ping === true) {
      return res.status(200).json({ ok: true, receivedAt: new Date().toISOString() });
    }

    const now = new Date();

    // normalize common Wix shapes to our document
    const orderNumber =
      (body.order && (body.order.number || body.order.id)) ||
      body.number || body.id || '';

    const createdAtStr =
      (body.order && body.order.createdDate) || body.createdDate || body.dateCreated;

    const buyer = body.buyerInfo || body.customer || {};
    const billing = (body.billingInfo && body.billingInfo.address) || {};

    // line items: accept body.items[] or body.lineItems[]
    let items = [];
    if (Array.isArray(body.items)) {
      items = body.items.map(i => ({
        sku: String(i.sku || ''),
        name: String(i.name || ''),
        qty: Number(i.qty || i.quantity || 1),
        unitPrice: Number(
          (i.unitPrice != null ? i.unitPrice :
           i.price && i.price.amount != null ? i.price.amount :
           i.price) || 0
        ),
        variants: i.variants || {}
      }));
    } else if (Array.isArray(body.lineItems)) {
      items = body.lineItems.map(i => ({
        sku: String(i.sku || ''),
        name: String(i.name || ''),
        qty: Number(i.quantity || 1),
        unitPrice: Number(
          (i.price && i.price.amount != null ? i.price.amount : i.price) || 0
        ),
        variants: {}
      }));
    }

    const totals = body.totals || {};
    const doc = {
      channel: 'wix',
      orderNumber: String(orderNumber || ''),
      _createdByWebhookAt: now,
      createdAt: createdAtStr ? new Date(createdAtStr) : now,

      customer: {
        name:
          buyer.name ||
          [buyer.firstName, buyer.lastName].filter(Boolean).join(' ').trim() ||
          '',
        email: buyer.email || '',
        phone: buyer.phone || '',
        address: {
          line1: body.address || billing.addressLine || billing.addressLine1 || '',
          city: body.city || billing.city || '',
          postcode: body.postalCode || billing.postalCode || ''
        }
      },

      delivery: {},
      supplier: {},
      payment: { method: (body.payment && body.payment.method) || body.paymentMethod || '' },

      items,
      totals: {
        grandTotal:
          Number(
            totals.total != null ? totals.total :
            totals.grandTotal != null ? totals.grandTotal : 0
          ),
        shipping: Number(totals.shipping || 0),
        discount: Number(totals.discount || 0),
        currency: String(totals.currency || 'TRY')
      },

      notes: String(body.notes || '')
    };

    const db = await getDb();
    const result = await db.collection('orders').insertOne(doc);

    return res.status(200).json({ ok: true, orderNumber: doc.orderNumber, id: String(result.insertedId) });
  } catch (e) {
    console.error('webhook error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'server_error' });
  }
};
