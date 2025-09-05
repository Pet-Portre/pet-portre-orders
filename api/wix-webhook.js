// api/wix-webhook.js
// Tolerant Wix webhook -> Mongo upsert (captures proper name + address)

'use strict';

const { withDb } = require('../lib/db');
const qs = require('querystring');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — wix-webhook');
    }

    // --- auth: ?token= | x-api-key | Authorization: Bearer ---
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const token = req.query.token || req.headers['x-api-key'] || bearer || '';
    if (!process.env.WIX_WEBHOOK_TOKEN || token !== process.env.WIX_WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // --- parse body (json, urlencoded, or raw) ---
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
    if (body.ping === true) return res.json({ ok: true, pong: true });

    // --- normalize shapes ---
    const raw =
      body.order ||
      body.data?.order ||
      body.data ||
      body.payload?.order ||
      body.payload ||
      body;

    // order number / id
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

    // created time
    const createdAtStr =
      raw?.createdAt ??
      raw?.createdDate ??
      raw?.created_time ??
      body?.eventTime ??
      null;
    const createdAt = createdAtStr ? new Date(createdAtStr) : new Date();

    // ---- derive customer/contact + shipping address ----
    const contact = raw?.contact || {};
    const nameObj = contact?.name || {};
    const firstName =
      nameObj?.first ||
      contact?.firstName ||
      raw?.billingInfo?.contactDetails?.firstName ||
      '';
    const lastName =
      nameObj?.last ||
      contact?.lastName ||
      raw?.billingInfo?.contactDetails?.lastName ||
      '';
    const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();

    const shipContact =
      raw?.shippingInfo?.logistics?.shippingDestination?.contactDetails ||
      raw?.shippingInfo?.shippingDestination?.contactDetails || {};

    const email =
      raw?.buyerEmail ||
      contact?.email ||
      raw?.billingInfo?.contactDetails?.email ||
      '';

    const phone =
      shipContact?.phone ||
      contact?.phone ||
      raw?.billingInfo?.contactDetails?.phone ||
      '';

    const addrSrc =
      raw?.shippingInfo?.logistics?.shippingDestination?.address ||
      raw?.shippingInfo?.shippingDestination?.address ||
      contact?.address ||
      raw?.billingInfo?.address ||
      {};

    const address = {
      formatted:
        addrSrc?.formattedAddressLine ||
        contact?.address?.formattedAddress ||
        '',
      addressLine: addrSrc?.addressLine || '',
      addressLine2: addrSrc?.addressLine2 || '',
      city: addrSrc?.city || '',
      subdivision: addrSrc?.subdivisionFullname || addrSrc?.subdivision || '',
      postalCode: addrSrc?.postalCode || '',
      country: addrSrc?.countryFullname || addrSrc?.country || ''
    };

    // map core fields
    const doc = {
      orderNumber: String(orderNumber),
      channel: raw?.channel || 'wix',
      createdAt,

      customer: {
        ...(raw?.buyerInfo || raw?.customer || {}),
        name: fullName || (raw?.buyerInfo?.name) || '',
        email,
        phone
      },

      items: raw?.lineItems || raw?.items || [],
      totals: raw?.totals || raw?.orderTotals || {},
      notes: raw?.notes || body?.notes || '',

      // store these for the exporter
      contact,
      shippingInfo: raw?.shippingInfo || {},
      address,
      _createdByWebhookAt: new Date()
    };

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
            contact: doc.contact,
            shippingInfo: doc.shippingInfo,
            address: doc.address,
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
