// api/wix-webhook.js
// Tolerant Wix webhook -> Mongo upsert (canonicalized)

const { withDb } = require('../lib/db');
const qs = require('querystring');

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — wix-webhook');
    }

    // --- auth (supports ?token=, x-api-key, Authorization: Bearer) ---
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const token =
      req.query.token ||
      req.headers['x-api-key'] ||
      bearer ||
      '';
    if (!process.env.WIX_WEBHOOK_TOKEN || token !== process.env.WIX_WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // --- body parsing (json or urlencoded or raw string) ---
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

    // --- normalize incoming shapes (order can be in several places) ---
    const raw =
      body.order ||
      body.data?.order ||
      body.data ||
      body.payload?.order ||
      body.payload ||
      body;

    // order number candidates (be generous)
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

    // created time candidates
    const createdAtStr =
      raw?.createdDate ??
      raw?.createdAt ??
      raw?.created_time ??
      body?.eventTime ??
      null;
    const createdAt = createdAtStr ? new Date(createdAtStr) : new Date();

    // ---- helpers -------------------------------------------------------
    const first = (...vals) => vals.find(v => v !== undefined && v !== null && String(v).trim() !== '');
    const fullName = (firstName, lastName) => [firstName, lastName].filter(Boolean).join(' ').trim();
    const joinAddr = (a) => {
      if (!a) return '';
      return [
        a.formattedAddress || a.formattedAddressLine,
        a.addressLine,
        a.addressLine2,
        a.city,
        a.subdivisionFullname || a.subdivision,
        a.postalCode,
        a.countryFullname || a.country
      ].filter(Boolean).join(', ')
        .replace(/\s+,/g, ',') // tidy
        .replace(/,+\s*,+/g, ', ')
        .replace(/\s{2,}/g, ' ')
        .trim();
    };
    const currencyOf = (obj, k = 'currency') => (obj && (obj.currency || obj[k])) || raw?.currency || 'TRY';

    // contact + address (prefer shipping, then billing, then contact)
    const shipAddr = raw?.shippingInfo?.address || null;
    const billAddr = raw?.billingInfo?.address || null;

    const shipContact = raw?.shippingInfo?.contactDetails || null;
    const billContact = raw?.billingInfo?.contactDetails || null;
    const contactRoot  = raw?.contact || null;

    const nameFirst = first(shipContact?.firstName, billContact?.firstName, contactRoot?.name?.first);
    const nameLast  = first(shipContact?.lastName,  billContact?.lastName,  contactRoot?.name?.last);
    const email     = first(raw?.buyerEmail, contactRoot?.email);
    const phone     = first(shipContact?.phone, billContact?.phone, contactRoot?.phone);

    const address = {
      full: first(
        shipAddr?.formattedAddress || shipAddr?.formattedAddressLine,
        billAddr?.formattedAddress || billAddr?.formattedAddressLine,
        joinAddr(shipAddr),
        joinAddr(billAddr)
      ),
      city: first(shipAddr?.city, billAddr?.city),
      district: first(shipAddr?.subdivisionFullname, shipAddr?.subdivision, billAddr?.subdivisionFullname, billAddr?.subdivision),
      postcode: first(shipAddr?.postalCode, billAddr?.postalCode),
      line1: first(shipAddr?.addressLine, billAddr?.addressLine),
      line2: first(shipAddr?.addressLine2, billAddr?.addressLine2),
      country: first(shipAddr?.countryFullname, shipAddr?.country, billAddr?.countryFullname, billAddr?.country)
    };

    // items normalization
    const rawItems = Array.isArray(raw?.lineItems) ? raw.lineItems : (Array.isArray(raw?.items) ? raw.items : []);
    const items = rawItems.map(li => {
      const qty = Number(li.quantity || li.qty || 0) || 0;
      // Compatible fields Wix may use
      const totalValue = Number(
        li.totalPrice?.value ??
        li.totalPriceBeforeTax?.value ??
        li.total?.value ??
        li.price?.total ??
        0
      ) || 0;
      const totalCurrency = currencyOf(li.totalPrice) || currencyOf(li);
      const unitPrice = qty > 0 ? +(totalValue / qty).toFixed(2) : totalValue;

      // description lines (attributes like Cinsiyet/Renk/Telefon Modeli/Tablo Boyutu)
      const descriptionLines = Array.isArray(li.descriptionLines)
        ? li.descriptionLines.map(d => ({ name: d.name || d.title || '', description: d.description || d.value || '' }))
        : [];

      const sku = first(li.sku, li.variant?.sku, li.catalogItem?.sku, li.product?.sku);

      return {
        id: li.id || li._id || li.itemId || undefined,
        name: li.name || li.productName || '',
        sku,
        quantity: qty,
        totalPrice: { value: totalValue, currency: totalCurrency },
        unitPrice: { value: unitPrice, currency: totalCurrency },
        descriptionLines
      };
    });

    // totals (order-level)
    const ps = raw?.priceSummary || {};
    const totals = {
      total:       { value: Number(ps.total?.value ?? 0) || 0,       currency: currencyOf(ps.total) },
      subtotal:    { value: Number(ps.subtotal?.value ?? 0) || 0,    currency: currencyOf(ps.subtotal) },
      shipping:    { value: Number(ps.shipping?.value ?? 0) || 0,    currency: currencyOf(ps.shipping) },
      discount:    { value: Number(ps.discount?.value ?? 0) || 0,    currency: currencyOf(ps.discount) },
      tax:         { value: Number(ps.tax?.value ?? 0) || 0,         currency: currencyOf(ps.tax) },
      additional:  { value: Number(ps.additionalFees?.value ?? 0) || 0, currency: currencyOf(ps.additionalFees) }
    };

    const doc = {
      orderNumber: String(orderNumber),
      channel: raw?.channelType || raw?.channel || 'wix',
      createdAt,
      customer: {
        name: fullName(nameFirst, nameLast),
        firstName: nameFirst || '',
        lastName: nameLast || '',
        email: email || '',
        phone: phone || ''
      },
      address,
      items,
      totals,
      notes: raw?.notes || body.notes || '',
      _createdByWebhookAt: new Date(),
      _firstSeenAt: new Date()
    };

    // --- upsert (idempotent by orderNumber) ---
    const result = await withDb(async (db) => {
      const col = db.collection('orders');
      return col.updateOne(
        { orderNumber: doc.orderNumber },
        {
          $setOnInsert: {
            orderNumber: doc.orderNumber,
            channel: doc.channel,
            createdAt: doc.createdAt,
            _firstSeenAt: doc._firstSeenAt
          },
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
