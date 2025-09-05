// api/wix-webhook.js
const { withDb } = require('../lib/db');

/**
 * Accepts either:
 *  A) { order: {...}, buyerInfo, lineItems, totals, shippingInfo, ... }
 *  B) Entire Wix payload where order fields sit at top level
 */
module.exports = async (req, res) => {
  try {
    // 1) Only POST + token guard
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — wix-webhook');
    }
    const token = req.query.token || req.headers['x-api-key'] || '';
    if (process.env.WIX_WEBHOOK_TOKEN && token !== process.env.WIX_WEBHOOK_TOKEN) {
      console.warn('wix-webhook 401: bad token');
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // 2) Parse body (Vercel usually gives parsed JSON; handle string fallback)
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) {
        console.error('wix-webhook invalid JSON body:', body);
        return res.status(400).json({ ok:false, error:'Invalid JSON' });
      }
    }
    body = body || {};

    // 3) Ping for quick checks
    if (body.ping) return res.json({ ok: true, pong: true });

    // 4) Normalize sources (wrapped or entire)
    const src = body.order && typeof body.order === 'object' ? body.order : body;

    // 5) Extract orderNumber (try several paths)
    const orderNumber =
      src.number ||
      src.orderNumber ||
      body.number ||
      body.orderNumber ||
      body.id ||
      src.id;

    if (!orderNumber) {
      console.error('wix-webhook 400: no order number. keys=', Object.keys(body || {}));
      return res.status(400).json({ ok:false, error:'Missing order number' });
    }

    // 6) Timestamps & channel
    const createdAt =
      src.createdAt || src.createdDate || body.createdAt || body.createdDate || new Date().toISOString();
    const channel = (src.channel || body.channel || 'wix').toString();

    // 7) Customer / buyer
    const buyer = body.buyerInfo || body.customer || src.customer || {};
    const firstName = buyer.firstName || buyer.givenName || '';
    const lastName  = buyer.lastName  || buyer.familyName || '';
    const fullName  = buyer.name || [firstName, lastName].filter(Boolean).join(' ') || '';
    const customer = {
      name: fullName,
      email: buyer.email || '',
      phone: buyer.phone || buyer.phoneNumber || ''
    };

    // 8) Address (from common Wix shapes)
    const ship = body.shippingInfo || body.shipping || src.shippingInfo || {};
    const addr = ship.address || ship.shippingAddress || buyer.address || {};
    const address = {
      line1: addr.addressLine1 || addr.line1 || addr.address || '',
      line2: addr.addressLine2 || addr.line2 || '',
      city: addr.city || '',
      district: addr.district || addr.subdistrict || '',
      postcode: addr.postcode || addr.postalCode || '',
      country: addr.country || addr.countryCode || ''
    };
    if (address.line1) customer.address = address;

    // 9) Items
    const itemsSrc = body.lineItems || body.items || src.items || [];
    const items = Array.isArray(itemsSrc) ? itemsSrc.map(it => ({
      sku:       it.sku || it.catalogId || '',
      name:      it.name || it.productName || '',
      qty:       Number(it.quantity || it.qty || 0),
      unitPrice: Number((it.price && (it.price.amount || it.price.value)) || it.unitPrice || 0)
    })) : [];

    // 10) Totals
    const totalsSrc = body.totals || body.orderTotals || src.totals || {};
    const totals = {
      total: Number(
        totalsSrc.total ??
        totalsSrc.grandTotal ??
        (body.totalPrice && (body.totalPrice.amount || body.totalPrice.value)) ??
        0
      ),
      currency: totalsSrc.currency || body.currency || 'TRY',
      shipping: Number(totalsSrc.shipping || 0),
      discount: Number(totalsSrc.discount || 0)
    };

    // 11) Status / deliveredAt / shippedAt (best-effort)
    const status =
      body.status || src.status || ship.status || 'Bekliyor';
    const deliveredAt = body.deliveredAt || src.deliveredAt || null;
    const shippedAt   = body.shippedAt   || src.shippedAt   || null;

    // 12) Optional notes
    const notes = body.notes || src.notes || '';

    // 13) Compose doc
    const doc = {
      orderNumber: String(orderNumber),
      channel,
      createdAt: new Date(createdAt),
      customer,
      items,
      totals,
      status,
      deliveredAt: deliveredAt ? new Date(deliveredAt) : null,
      shippedAt:   shippedAt   ? new Date(shippedAt)   : null,
      _createdByWebhookAt: new Date()
    };

    // 14) Upsert in Mongo
    const result = await withDb(async (db) => {
      const col = db.collection('orders');
      return col.updateOne(
        { orderNumber: doc.orderNumber },
        {
          $setOnInsert: { orderNumber: doc.orderNumber, channel: doc.channel, createdAt: doc.createdAt },
          $set: {
            customer: doc.customer,
            items: doc.items,
            totals: doc.totals,
            status: doc.status,
            deliveredAt: doc.deliveredAt,
            shippedAt: doc.shippedAt,
            notes: notes,
            _createdByWebhookAt: doc._createdByWebhookAt
          }
        },
        { upsert: true }
      );
    });

    // 15) Log to Vercel to confirm writes
    console.log('wix-webhook upsert', {
      orderNumber: doc.orderNumber,
      matched: result.matchedCount,
      modified: result.modifiedCount,
      upserted: result.upsertedId ? true : false
    });

    return res.json({
      ok: true,
      orderNumber: doc.orderNumber,
      matched: result.matchedCount,
      modified: result.modifiedCount,
      upserted: !!result.upsertedId
    });
  } catch (err) {
    console.error('wix-webhook error:', err);
    return res.status(500).json({ ok:false, error: err.message });
  }
};
