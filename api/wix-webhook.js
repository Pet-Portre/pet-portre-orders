// api/wix-webhook.js
const { withDb } = require('../lib/db');

function getToken(req) {
  const h = req.headers || {};
  const q = req.query || {};
  const auth = (h.authorization || '').trim(); // "Bearer xyz"
  if (q.token) return String(q.token);
  if (h['x-api-key']) return String(h['x-api-key']);
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '');
  return '';
}

function safeJson(body) {
  if (!body) return {};
  if (typeof body === 'object') return body;
  try { return JSON.parse(body); } catch { return {}; }
}

function fullName(p) {
  if (!p) return '';
  return p.name || [p.firstName, p.lastName].filter(Boolean).join(' ') || '';
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ ok:false, error:'POST only — wix-webhook' });
    }

    const expected = process.env.WIX_WEBHOOK_TOKEN || '';
    const got = getToken(req);
    if (!expected || got !== expected) {
      return res.status(401).json({ ok:false, error:'Unauthorized' });
    }

    const body = safeJson(req.body);
    if (body.ping === true) return res.json({ ok:true, pong:true });

    // Accept both Automation JSON and Wix Stores payloads
    const o = body.order || body;
    const customer =
      body.customer ||
      o.customer ||
      body.shippingDestinationContact ||
      body.contactDetails ||
      {};

    const items =
      Array.isArray(body.items) ? body.items :
      Array.isArray(o.items) ? o.items :
      Array.isArray(body.orderedItems) ? body.orderedItems : [];

    const totals = body.totals || o.totals || {};

    const doc = {
      orderNumber: o.number || body.orderNumber || body['Order number'] || '',
      createdAt:   o.createdAt || body.createdAt || body['Date created'] || new Date().toISOString(),
      channel:     o.channel || process.env.APP_CHANNEL_DEFAULT || 'wix',

      customer: {
        name:   fullName(customer),
        email:  customer.email || body.customerEmail || '',
        phone:  customer.phone || body.shippingDestinationContactPhoneNumber || '',
        // single-line address for labels & sheet
        address: body.shippingFormattedAddress ||
                 [body.shippingAddressLine, body.shippingAddressLine2].filter(Boolean).join(' ') ||
                 customer.address || '',
        city:     body.shippingAddressCity || customer.city || '',
        district: body.shippingAddressSubdivision || customer.district || '',
        postcode: body.shippingAddressPostalCode || customer.postalCode || ''
      },

      items: items.map(it => ({
        sku:       it.sku || it.SKU || it.orderedItemSKU || it.catalogSku || '',
        name:      it.name || it.orderedItemName || it.productName || '',
        qty:       Number(it.qty || it.quantity || it.orderedItemQuantity || 1),
        unitPrice: Number(it.unitPrice || it.price || it.totalPriceBeforeTaxValue || it.itemPrice || 0)
      })),

      totals: {
        total:    Number((totals.total ?? body.orderTotalValue ?? body.totalPriceValue) || 0),
        currency: totals.currency || body.orderTotalCurrency || body.totalPriceCurrency || 'TRY'
      },

      notes: body.notes || o.notes || '',
      _createdByWebhookAt: new Date().toISOString()
    };

    if (!doc.orderNumber) {
      return res.status(400).json({ ok:false, error:'Missing order.number' });
    }

    await withDb(async (db) => {
      await db.collection('orders').updateOne(
        { orderNumber: doc.orderNumber },
        { $setOnInsert: { orderNumber: doc.orderNumber }, $set: doc },
        { upsert: true }
      );
    });

    res.json({ ok:true, orderNumber: doc.orderNumber, upserted:true });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
};
