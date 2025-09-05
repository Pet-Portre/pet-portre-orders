// api/wix-webhook.js
// Robust Wix webhook → Mongo upsert (Order placed / Invoice paid "Entire payload")

const { withDb } = require('../lib/db');
const qs = require('querystring');

function toStringSafe(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : undefined; }

// Pull common fields from Wix "Entire payload"
function normalizeFromRaw(raw) {
  // Order number & created date
  const orderNumber =
      raw?.orderNumber ??
      raw?.number ??
      raw?.id ??
      raw?._id ??
      raw?.referenceNumber ??
      raw?.reference ??
      null;

  // Created time
  const createdAtStr =
      raw?.createdDate ??
      raw?.createdAt ??
      raw?.dateCreated ??
      raw?.eventTime ??
      null;

  // Contact / email / phone
  const buyerEmail = raw?.buyerEmail || raw?.contact?.email || '';
  const contactFirst = raw?.contact?.name?.first || raw?.shippingInfo?.shippingDestination?.contactDetails?.firstName || '';
  const contactLast  = raw?.contact?.name?.last  || raw?.shippingInfo?.shippingDestination?.contactDetails?.lastName  || '';
  const contactPhone =
      raw?.shippingInfo?.shippingDestination?.contactDetails?.phone ||
      raw?.contact?.phone || '';

  const customerName = [contactFirst, contactLast].filter(Boolean).join(' ').trim();

  // Address (prefer formatted)
  const ship = raw?.shippingInfo || {};
  const addr = ship.address || {};
  const fullAddress =
      addr.formattedAddress ||
      addr.formattedAddressLine ||
      [
        addr.addressLine, addr.addressLine2,
        addr.city, addr.subdivisionFullname || addr.subdivision,
        addr.postalCode, addr.countryFullname || addr.country
      ].filter(Boolean).join(', ');

  // Line items (use first for “1 row per order”)
  const items = Array.isArray(raw?.lineItems) ? raw.lineItems : [];
  const first = items[0] || {};
  const descLines = Array.isArray(first?.descriptionLines) ? first.descriptionLines : [];
  const descMap = {};
  descLines.forEach(d => {
    const k = toStringSafe(d?.name || '').trim().toLowerCase();
    const v = toStringSafe(d?.description || '').trim();
    if (k) descMap[k] = v;
  });

  // Quantities & prices
  const qty = num(first?.quantity) ?? 0;
  const lineTotal =
      num(first?.totalPrice?.value) ??
      num(first?.totalPriceValue) ??
      num(first?.price?.total?.value) ?? 0;
  const unitPrice =
      num(first?.unitPrice?.value) ??
      (qty && lineTotal ? Math.round((lineTotal / qty) * 100) / 100 : undefined);

  // Currency
  const currency =
      first?.totalPrice?.currency ||
      first?.price?.total?.currency ||
      raw?.priceSummary?.total?.currency ||
      raw?.currency || 'TRY';

  // Order totals / discount / shipping
  const orderTotal =
      num(raw?.priceSummary?.total?.value) ??
      num(raw?.orderTotal?.value) ??
      num(raw?.priceSummary?.total) ?? 0;

  const discountTotal =
      num(raw?.priceSummary?.discount?.value) ??
      (Array.isArray(raw?.appliedDiscounts)
        ? raw.appliedDiscounts.reduce((s, d) => s + (num(d?.amount?.value) || 0), 0)
        : 0);

  const shippingAmount =
      num(ship?.amount?.value) ??
      num(raw?.priceSummary?.shipping?.value) ?? 0;

  // Payment method (best effort)
  const payments = Array.isArray(raw?.payments) ? raw.payments : [];
  const paymentMethod =
      payments[0]?.paymentMethod ||
      payments[0]?.paymentGateway ||
      payments[0]?.provider ||
      raw?.paymentStatus || '';

  return {
    ok: !!orderNumber,
    orderNumber: orderNumber ? String(orderNumber) : null,
    createdAt: createdAtStr ? new Date(createdAtStr) : new Date(),
    channel: raw?.channelType || raw?.channel || 'wix',

    // customer & address
    customer: {
      name: customerName || undefined,
      email: buyerEmail || undefined,
      phone: contactPhone || undefined
    },
    address: { full: fullAddress || undefined },

    // 1st line-item summary (we still store all)
    items: items,
    firstItem: {
      sku: first?.sku || first?.catalogItemSku || '',
      name: first?.name || first?.productName || '',
      quantity: qty || undefined,
      unitPrice: unitPrice,
      lineTotal: lineTotal,
      currency,
      attributes: {
        beden: descMap['beden'],
        cinsiyet: descMap['cinsiyet'],
        renk: descMap['renk'] || descMap['color'],
        telefonModeli: descMap['telefon modeli'],
        tabloBoyutu: descMap['tablo boyutu']
      },
      descriptionLines: descLines
    },

    // order totals
    totals: {
      orderTotal,
      discountTotal: discountTotal || 0,
      currency
    },
    shipping: {
      amount: shippingAmount || 0,
      currency
    },
    payment: {
      method: paymentMethod || ''
    },

    notes: (raw?.checkoutCustomFields
      ? toStringSafe(raw.checkoutCustomFields)
      : (first?.description || '')
    ) || '',

    // raw for future-proofing
    _raw: raw
  };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — wix-webhook');
    }

    // --- Auth (token can be in ?token=, x-api-key, or Bearer) ---
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const token = req.query.token || req.headers['x-api-key'] || bearer || '';
    if (!process.env.WIX_WEBHOOK_TOKEN || token !== process.env.WIX_WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // --- Parse body (JSON / x-www-form-urlencoded / raw) ---
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

    // Wix can wrap order as {order}, {data}, {payload:{order}}, or flat
    const raw =
      body.order ||
      body.data?.order ||
      body.data ||
      body.payload?.order ||
      body.payload ||
      body;

    const norm = normalizeFromRaw(raw);
    if (!norm.ok) return res.status(400).json({ ok: false, error: 'Missing orderNumber' });

    // --- Upsert in Mongo ---
    const result = await withDb(async (db) => {
      const col = db.collection('orders');
      const now = new Date();

      return col.updateOne(
        { orderNumber: String(norm.orderNumber) },
        {
          $setOnInsert: {
            orderNumber: String(norm.orderNumber),
            channel: norm.channel || 'wix',
            createdAt: norm.createdAt,
            _firstSeenAt: now
          },
          $set: {
            customer: norm.customer,
            address: norm.address,
            items: norm.items,
            firstItem: norm.firstItem,
            totals: norm.totals,
            shipping: norm.shipping,
            payment: norm.payment,
            notes: norm.notes,
            _createdByWebhookAt: now,
            _raw: norm._raw
          }
        },
        { upsert: true }
      );
    });

    return res.json({
      ok: true,
      orderNumber: norm.orderNumber,
      upserted: result.upsertedCount === 1,
      matched: result.matchedCount,
      modified: result.modifiedCount
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
