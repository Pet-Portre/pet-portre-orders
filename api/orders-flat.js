// api/orders-flat.js
// Export flattened orders for Google Sheets

'use strict';

const { withDb } = require('../lib/db');

/** ---------- helpers ---------- */
const TZ = 'Europe/Istanbul';

function fmtTRDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  // dd.MM.yyyy HH:mm
  const pad = (n) => String(n).padStart(2, '0');
  const y = dt.toLocaleString('tr-TR', { timeZone: TZ, year: 'numeric' });
  const m = pad(Number(dt.toLocaleString('tr-TR', { timeZone: TZ, month: '2-digit' })));
  const day = pad(Number(dt.toLocaleString('tr-TR', { timeZone: TZ, day: '2-digit' })));
  const hh = pad(Number(dt.toLocaleString('tr-TR', { timeZone: TZ, hour: '2-digit', hour12: false })));
  const mm = pad(Number(dt.toLocaleString('tr-TR', { timeZone: TZ, minute: '2-digit' })));
  return `${day}.${m}.${y} ${hh}:${mm}`;
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : '';
}

function str(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

function pick(...cands) {
  for (const c of cands) {
    if (c !== undefined && c !== null && c !== '') return c;
  }
  return undefined;
}

function sum(arr, selector) {
  if (!Array.isArray(arr) || !arr.length) return undefined;
  let total = 0;
  let seen = false;
  for (const it of arr) {
    const v = selector(it);
    const num = Number(v);
    if (Number.isFinite(num)) {
      total += num;
      seen = true;
    }
  }
  return seen ? total : undefined;
}

function getCustomerName(doc) {
  const c = doc.customer || doc.contact || {};
  const nameObj = c.name || {};
  const first = pick(nameObj.first, c.firstName, c.givenName);
  const last = pick(nameObj.last, c.lastName, c.familyName);
  const full = pick(c.name, [first, last].filter(Boolean).join(' ').trim());
  return full || '';
}

function getEmail(doc) {
  return (
    pick(
      doc.customer?.email,
      doc.buyerEmail,
      doc.contact?.email,
      doc.billingInfo?.contactDetails?.email
    ) || ''
  );
}

function getPhone(doc) {
  return (
    pick(
      doc.shippingInfo?.destination?.contactDetails?.phone,
      doc.shippingInfo?.contactDetails?.phone,
      doc.billingInfo?.contactDetails?.phone,
      doc.contact?.phone,
      doc.customer?.phone
    ) || ''
  );
}

// SHIPPING-ONLY address (no fallbacks to billing/contact)
function getAddress(doc) {
  const a =
    doc.shippingInfo?.address ||
    doc.shippingInfo?.destination?.address ||
    null;

  const formatted = a?.formattedAddressLine;
  if (formatted) return str(formatted);

  if (!a) return '';

  const line = [a.addressLine, a.addressLine2].filter(Boolean).join(' ');
  const city = a.city || '';
  const sub = a.subdivisionFullname || a.subdivision || '';
  const pc = a.postalCode || '';
  const country = a.countryFullname || a.country || '';
  const parts = [line, city, sub, pc, country].filter(Boolean);
  return parts.length ? parts.join(', ') : '';
}

function extractItemFields(doc) {
  const items = Array.isArray(doc.items) ? doc.items : Array.isArray(doc.lineItems) ? doc.lineItems : [];
  const first = items[0] || {};

  // Try to read options like Beden, Cinsiyet, Renk, Telefon Modeli, Tablo Boyutu
  const opt = {};
  const rawOpts =
    first.options ||
    first.modifiers ||
    first.descriptionLines ||
    first.description ||
    [];

  const asArray = Array.isArray(rawOpts) ? rawOpts : [];
  for (const o of asArray) {
    const label = str(o.name || o.title || o.label || o.option || o.key).toLowerCase();
    const value = str(o.value || o.text || o.description || o.optionValue);
    if (!label) continue;

    if (label.includes('beden') || label.includes('size')) opt.beden = value;
    else if (label.includes('cinsiyet') || label.includes('gender')) opt.cinsiyet = value;
    else if (label.includes('renk') || label.includes('color')) opt.renk = value;
    else if (label.includes('telefon') || label.includes('phone')) opt.telefonModeli = value;
    else if (label.includes('tablo') || label.includes('canvas') || label.includes('boyut') || label.includes('size')) {
      if (!opt.tabloBoyutu) opt.tabloBoyutu = value;
    }
  }

  const qty = pick(first.quantity, first.qty, 1);
  const unitPrice =
    pick(first.price, first.unitPrice?.value, first.priceBeforeTax?.value, first.totalPriceBeforeTax?.value && qty ? Number(first.totalPriceBeforeTax.value) / Number(qty) : undefined) || '';
  const lineTotal =
    pick(first.totalPrice?.value, first.totalPriceBeforeTax?.value, (unitPrice && qty) ? Number(unitPrice) * Number(qty) : undefined) || '';

  return {
    sku: str(pick(first.sku, first.code, first.id)),
    name: str(pick(first.name, first.title, first.description, first.itemName)),
    qty: n(qty),
    unitPrice: n(unitPrice),
    lineTotal: n(lineTotal),
    ...opt
  };
}

/**
 * Compute:
 *  - shippingFee: from priceSummary/shippingInfo
 *  - discount: includes coupons, automatic promos, line-item discounts
 *  - totalPaid: amount actually paid (handles 0 correctly)
 *  - currency: best-effort
 */
function fromTotals(doc) {
  const items = Array.isArray(doc.items) ? doc.items : Array.isArray(doc.lineItems) ? doc.lineItems : [];

  const shippingFee = pick(
    doc.totals?.shipping?.value,
    doc.priceSummary?.shipping?.value,
    doc.shippingInfo?.totalPriceAfterTax?.value,
    doc.shippingInfo?.price?.value
  );

  // İndirim (₺)
  const discount = pick(
    doc.priceSummary?.discount?.value,
    sum(doc.appliedDiscounts, d => d?.amount?.value),
    sum(items, it => it?.totalDiscount?.value),
    0
  );

  // Sipariş Toplam Fiyat (paid by customer)
  const totalPaid = pick(
    doc.balanceSummary?.paid?.value,
    sum(doc.payments, p => p?.amount?.value),
    doc.priceSummary?.total?.value,
    (() => {
      const subtotal = pick(
        doc.priceSummary?.subtotal?.value,
        sum(items, it => it?.totalPrice?.value)
      ) || 0;
      const ship = pick(
        doc.priceSummary?.shipping?.value,
        doc.shippingInfo?.totalPriceAfterTax?.value,
        doc.shippingInfo?.price?.value
      ) || 0;
      const tax = doc.priceSummary?.tax?.value || 0;
      const fees = doc.priceSummary?.additionalFees?.value || 0;
      const disc = Number.isFinite(Number(discount)) ? Number(discount) : 0;
      return subtotal + ship + fees + tax - disc;
    })()
  );

  const currency = pick(
    doc.currency,
    doc.totals?.total?.currency,
    doc.priceSummary?.total?.currency,
    doc.priceSummary?.subtotal?.currency,
    doc.shippingInfo?.totalPriceAfterTax?.currency,
    doc.shippingInfo?.price?.currency
  ) || 'TRY';

  return {
    shippingFee: n(shippingFee),
    discount: n(discount),
    total: n(totalPaid),
    currency: str(currency)
  };
}

function dhlBits(doc) {
  return {
    ref: str(pick(doc.dhl?.referenceId, doc.referenceId, doc.dhlReference)),
    carrier: str(pick(doc.dhl?.carrier, doc.carrier, doc.shippingCarrier)),
    tracking: str(pick(doc.dhl?.trackingNumber, doc.trackingNumber)),
    shippedAt: fmtTRDate(pick(doc.shippedAt, doc.fulfilledAt, doc.logistics?.shippedAt)),
    status: str(pick(doc.deliveryStatus, doc.statusText, doc.trackingStatus)),
    deliveredAt: fmtTRDate(pick(doc.deliveredAt))
  };
}

/** ---------- fixed header order (must match Sheet) ---------- */
const HEADERS = [
  'Sipariş No','Sipariş Tarihi','Sipariş Kanalı',
  'Tedarikçi Adı','Tedarikçi Sipariş No','Tedarikçi Kargo Firması','Tedarikçi Kargo Takip No','Tedarikçiye Veriliş Tarihi','Tedarikçiden Teslim Tarihi',
  'DHL Referans No',
  'Müşteri Adı','Adres',
  'SKU','Ürün','Adet','Birim Fiyat','Ürün Toplam Fiyat',
  'Beden','Cinsiyet','Renk','Telefon Modeli','Tablo Boyutu',
  'Ödeme Yöntemi','Kargo Ücreti',
  'Kargo Firması','Kargo Takip No','Kargoya Veriliş Tarihi','Teslimat Durumu','Teslimat Tarihi',
  'Sipariş Toplam Fiyat','İndirim (₺)','Para Birimi','Notlar','E-posta','Telefon'
];

/** ---------- handler ---------- */
module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).send('GET only — orders-flat');
    }

    // --- auth ---
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const provided =
      req.query.key ||
      req.headers['x-api-key'] ||
      bearer ||
      '';
    const expected =
      process.env.EXPORT_TOKEN ||      // <-- your env var
      process.env.EXPORT_KEY ||
      process.env.ORDERS_EXPORT_KEY ||
      process.env.WIX_EXPORT_KEY ||
      '';

    if (!expected || provided !== expected) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // --- read orders ---
    const { rows } = await withDb(async (db) => {
      const col = db.collection('orders');
      const docs = await col
        .find({})
        .sort({ createdAt: -1 })
        .limit(2000)
        .toArray();

      const out = docs.map((doc) => {
        const orderNo = str(
          doc.orderNumber || doc.number || doc.id || doc._id?.toString() || ''
        );
        const created = fmtTRDate(
          doc.createdAt || doc.createdDate || doc._createdByWebhookAt
        );
        const channel = str((doc.channel || 'wix').toString().toLowerCase());

        // supplier editable block is blank
        const supplier = ['', '', '', '', ''];

        const dhl = dhlBits(doc);
        const customerName = getCustomerName(doc);
        const address = getAddress(doc);

        const item = extractItemFields(doc);
        const totals = fromTotals(doc);

        const paymentMethod = str(
          pick(
            doc.payment?.method,
            doc.paymentMethod,
            doc.payments?.[0]?.method,
            doc.priceSummary?.paymentMethod
          ) || ''
        );

        const email = getEmail(doc);
        const phone = getPhone(doc);

        const notes = str(doc.notes || '');

        return [
          // 1..3
          orderNo,
          created,
          channel,

          // 4..8 (supplier-editable placeholders)
          ...supplier,

          // 9
          dhl.ref,

          // 10..12
          customerName,
          address,

          // 13..17
          item.sku,
          item.name,
          item.qty,
          item.unitPrice,
          item.lineTotal,

          // 18..22
          item.beden || '',
          item.cinsiyet || '',
          item.renk || '',
          item.telefonModeli || '',
          item.tabloBoyutu || '',

          // 23..24
          paymentMethod,
          totals.shippingFee,

          // 25..29
          dhl.carrier,
          dhl.tracking,
          dhl.shippedAt,
          dhl.status,
          dhl.deliveredAt,

          // 30..32
          totals.total,
          totals.discount,
          totals.currency,

          // 33..35
          notes,
          email,
          phone
        ];
      });

      return { rows: out };
    });

    return res.json({ ok: true, headers: HEADERS, rows });
  } catch (err) {
    console.error('orders-flat error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
