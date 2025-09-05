// api/orders-flat.js
// Export flattened orders for Google Sheets — mapped to Wix "Order placed" payload

'use strict';

const { withDb } = require('../lib/db');

/** ---------- helpers ---------- */
const TZ = 'Europe/Istanbul';

function fmtTRDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  const y = dt.toLocaleString('tr-TR', { timeZone: TZ, year: 'numeric' });
  const m = pad(Number(dt.toLocaleString('tr-TR', { timeZone: TZ, month: '2-digit' })));
  const day = pad(Number(dt.toLocaleString('tr-TR', { timeZone: TZ, day: '2-digit' })));
  const hh = pad(Number(dt.toLocaleString('tr-TR', { timeZone: TZ, hour: '2-digit', hour12: false })));
  const mm = pad(Number(dt.toLocaleString('tr-TR', { timeZone: TZ, minute: '2-digit' })));
  return `${day}.${m}.${y} ${hh}:${mm}`;
}

function n(v, ifEmpty = '') {
  if (v === '' || v === null || v === undefined) return ifEmpty;
  const x = Number(String(v).replace(',', '.'));
  return Number.isFinite(x) ? x : ifEmpty;
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

// safe nested getter: pickPath(doc, 'a.b.c')
function pickPath(obj, path) {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((acc, k) => (acc && acc[k] != null ? acc[k] : undefined), obj);
}

function normalizePhoneTR(p) {
  if (!p) return '';
  let s = ('' + p).replace(/\D+/g, '');
  if (s.length === 11 && s[0] === '0') s = s.slice(1);
  if (s.length === 10) return '0' + s;
  return s;
}

function getCustomerName(doc) {
  // Prefer shipping contact (firstName/lastName), else contact/customer
  const fn = pick(
    pickPath(doc, 'shippingInfo.logistics.shippingDestination.contactDetails.firstName'),
    pickPath(doc, 'shippingInfo.destination.contactDetails.firstName'),
    doc.customer?.firstName,
    doc.contact?.name?.first
  );
  const ln = pick(
    pickPath(doc, 'shippingInfo.logistics.shippingDestination.contactDetails.lastName'),
    pickPath(doc, 'shippingInfo.destination.contactDetails.lastName'),
    doc.customer?.lastName,
    doc.contact?.name?.last
  );
  const full = [fn, ln].filter(Boolean).join(' ').trim();
  return full || str(pick(doc.customer?.name, doc.contact?.name, ''));
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
  const p = pick(
    pickPath(doc, 'shippingInfo.logistics.shippingDestination.contactDetails.phone'),
    pickPath(doc, 'shippingInfo.destination.contactDetails.phone'),
    pickPath(doc, 'shippingInfo.contactDetails.phone'),
    doc.billingInfo?.contactDetails?.phone,
    doc.contact?.phone,
    doc.customer?.phone
  );
  return normalizePhoneTR(p || '');
}

function getAddress(doc) {
  // Prefer formatted shipping address (logistics.shippingDestination)
  const formatted = pick(
    pickPath(doc, 'shippingInfo.logistics.shippingDestination.address.formattedAddressLine'),
    pickPath(doc, 'shippingInfo.logistics.shippingDestination.formattedAddress'),
    pickPath(doc, 'shippingInfo.address.formattedAddressLine'),
    pickPath(doc, 'shippingInfo.destination.address.formattedAddressLine'),
    doc.contact?.address?.formattedAddress,
    doc.billingInfo?.address?.formattedAddressLine
  );
  if (formatted) return formatted;

  // Compose single string for label (TR friendly order)
  const a =
    pickPath(doc, 'shippingInfo.logistics.shippingDestination.address') ||
    pickPath(doc, 'shippingInfo.address') ||
    pickPath(doc, 'shippingInfo.destination.address') ||
    doc.billingInfo?.address ||
    doc.contact?.address ||
    {};

  const line = [a.addressLine, a.addressLine2].filter(Boolean).join(' ');
  const city = a.city || '';
  const sub = a.subdivisionFullname || a.subdivision || '';
  const pc = a.postalCode || '';
  const country = a.countryFullname || a.country || '';

  return [line, city, sub, pc, country].filter(Boolean).join(', ');
}

// parse options (Beden, Cinsiyet, Renk, Telefon Modeli, Tablo Boyutu)
function parseOptionsFromDesc(descLines) {
  const opt = { beden: '', cinsiyet: '', renk: '', telefonModeli: '', tabloBoyutu: '' };
  const arr = Array.isArray(descLines) ? descLines : [];
  for (const o of arr) {
    const label = str(o.name || o.title || o.label || o.option || o.key).toLowerCase();
    const value = str(o.value || o.text || o.description || o.optionValue);
    if (!label) continue;
    if (/\b(beden|size)\b/.test(label)) opt.beden = value;
    else if (/\b(cinsiyet|gender)\b/.test(label)) opt.cinsiyet = value;
    else if (/\b(renk|color)\b/.test(label)) opt.renk = value;
    else if (/telefon.*model/i.test(label) || /phone.*model/i.test(label)) opt.telefonModeli = value;
    else if (/(tablo|canvas).*(boyut|size)/i.test(label) || /\bboyut\b/.test(label)) {
      if (!opt.tabloBoyutu) opt.tabloBoyutu = value;
    }
  }
  return opt;
}

// group identical variants into a single row (sku + option combo)
function groupLineItems(items = []) {
  const groups = new Map();

  for (const li of items) {
    const sku = str(pick(li.sku, li.code, li.id, li.catalogItemId, li.rootCatalogItemId));
    const name = str(pick(li.itemName, li.name, li.title, li.description));
    const qty = n(pick(li.quantity, li.qty, 1), 1);

    const total = n(
      pick(li.totalPrice?.value, li.totalPriceBeforeTax?.value, li.price?.total, li.total),
      0
    );

    const opts = parseOptionsFromDesc(li.descriptionLines);
    const gKey = [sku, opts.beden, opts.cinsiyet, opts.renk, opts.telefonModeli, opts.tabloBoyutu].join('|');

    if (!groups.has(gKey)) {
      groups.set(gKey, {
        sku,
        name,
        ...opts,
        qty: 0,
        total: 0
      });
    }
    const g = groups.get(gKey);
    g.qty += qty;
    g.total += total;
  }

  return Array.from(groups.values());
}

function fromTotals(doc) {
  const ship = pick(
    doc.totals?.shipping?.value,
    doc.priceSummary?.shipping?.value,
    doc.shippingInfo?.price?.value
  );
  const discount = pick(
    doc.totals?.discount?.value,
    doc.priceSummary?.discount?.value
  );
  const total = pick(
    doc.totals?.total?.value,
    doc.priceSummary?.total?.value,
    doc.orderTotal?.value
  );
  const currency = pick(
    doc.currency,
    doc.totals?.total?.currency,
    doc.priceSummary?.total?.currency,
    doc.priceSummary?.subtotal?.currency
  );

  return {
    shippingFee: n(ship, 0),
    discount: n(discount, 0),
    total: n(total, 0),
    currency: str(currency || 'TRY')
  };
}

function dhlBits(doc) {
  return {
    ref: str(pick(doc.dhl?.referenceId, doc.referenceId, doc.dhlReference)),
    carrier: str(pick(doc.dhl?.carrier, doc.carrier, doc.shippingCarrier)),
    tracking: str(pick(doc.dhl?.trackingNumber, doc.trackingNumber)),
    shippedAt: fmtTRDate(pick(doc.shippedAt, doc.fulfilledAt, doc.logistics?.shippedAt)),
    status: str(pick(doc.deliveryStatus, doc.statusText, doc.trackingStatus)),
    deliveredAt: fmtTRDate(pick(doc.deliveredAt)),
    labelUrl: str(pick(doc.dhl?.labelUrl, doc.labelUrl, doc.labelLink))
  };
}

function paymentMethodFrom(doc) {
  // Keep simple; don’t invent values if not present
  const p = Array.isArray(doc.payments) ? doc.payments[0] : null;
  if (p?.membershipName) return `Üyelik: ${p.membershipName}`;
  if (p?.creditCardLastDigits) return `Kredi Kartı •••• ${p.creditCardLastDigits}`;
  return str(pick(doc.payment?.method, doc.paymentMethod, doc.priceSummary?.paymentMethod, ''));
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
  'Sipariş Toplam Fiyat','İndirim (₺)','Para Birimi','Notlar','E-posta','Telefon','Kargo Etiket PDF'
];

/** ---------- handler ---------- */
module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).send('GET only — orders-flat');
    }

    // --- auth (kept tolerant; primary is EXPORT_TOKEN) ---
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const provided =
      req.query.key ||
      req.headers['x-api-key'] ||
      bearer ||
      '';
    const expected =
      process.env.EXPORT_TOKEN ||      // <— your env var
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

      const out = [];

      for (const doc of docs) {
        const orderNo = str(pick(doc.orderNumber, doc.number, doc.id, doc._id?.toString(), ''));
        const created = fmtTRDate(pick(doc.createdAt, doc.createdDate, doc._createdByWebhookAt));
        // prefer 'wix' unless you explicitly stored otherwise
        const channel = (str(doc.channel || 'wix').toLowerCase() === 'wix') ? 'wix' : str(doc.channel || 'wix');

        // supplier editable placeholders (Sheet preserves these)
        const supplier = ['', '', '', '', ''];

        const dhl = dhlBits(doc);
        const customerName = getCustomerName(doc);
        const address = getAddress(doc);
        const email = getEmail(doc);
        const phone = getPhone(doc);
        const totals = fromTotals(doc);
        const payMethod = paymentMethodFrom(doc);
        const notes = str(doc.notes || '');

        // line-items (grouped)
        const items = Array.isArray(doc.items) ? doc.items : Array.isArray(doc.lineItems) ? doc.lineItems : [];
        const groups = groupLineItems(items);

        if (groups.length === 0) {
          // still emit a single row so order appears
          out.push([
            orderNo, created, channel,
            ...supplier,
            dhl.ref,
            customerName, address,
            '', '', '', '', '',     // SKU, Ürün, Adet, Birim, Toplam
            '', '', '', '', '',     // Beden..Tablo Boyutu
            payMethod, totals.shippingFee,
            dhl.carrier, dhl.tracking, dhl.shippedAt, dhl.status, dhl.deliveredAt,
            totals.total, totals.discount, totals.currency, notes, email, phone, dhl.labelUrl
          ]);
          continue;
        }

        for (const g of groups) {
          const qty = n(g.qty, 1);
          const lineTotal = n(g.total, 0);
          const unit = qty ? Number((lineTotal / qty).toFixed(2)) : '';

          out.push([
            orderNo, created, channel,
            ...supplier,
            dhl.ref,
            customerName, address,
            g.sku || '', g.name || '', qty, unit, lineTotal,
            g.beden || '', g.cinsiyet || '', g.renk || '', g.telefonModeli || '', g.tabloBoyutu || '',
            payMethod, totals.shippingFee,
            dhl.carrier, dhl.tracking, dhl.shippedAt, dhl.status, dhl.deliveredAt,
            totals.total, totals.discount, totals.currency, notes, email, phone, dhl.labelUrl
          ]);
        }
      }

      return { rows: out };
    });

    return res.json({ ok: true, headers: HEADERS, rows });
  } catch (err) {
    console.error('orders-flat error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
