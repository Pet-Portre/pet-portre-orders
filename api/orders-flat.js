// api/orders-flat.js
// Export orders as [headers, rows] for Google Sheets (FINAL TR headers, includes Telefon)

const { withDb } = require('../lib/db');

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

// Istanbul date formatting: dd.MM.yyyy HH:mm
function fmtTRDate(d) {
  try {
    const dt = (d instanceof Date) ? d : new Date(d);
    if (!isFinite(dt)) return '';
    return new Intl.DateTimeFormat('tr-TR', {
      timeZone: 'Europe/Istanbul',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(dt).replace(',', '');
  } catch { return ''; }
}

function firstItem(doc) {
  if (Array.isArray(doc?.items) && doc.items.length) return doc.items[0];
  if (Array.isArray(doc?.lineItems) && doc.lineItems.length) return doc.lineItems[0];
  return null;
}

function val(obj, path, def='') {
  try {
    return path.split('.').reduce((a,k)=> (a && a[k] != null ? a[k] : undefined), obj) ?? def;
  } catch { return def; }
}

function pickName(doc) {
  // stored customer name string?
  const cn = doc?.customer?.name;
  if (typeof cn === 'string' && cn.trim()) return cn.trim();

  // contact name parts?
  const first = val(doc, 'contact.name.first', '');
  const last  = val(doc, 'contact.name.last', '');
  const joined = [first, last].filter(Boolean).join(' ');
  if (joined) return joined;

  // shipping contact?
  const sfirst = val(doc, 'shippingInfo.shippingDestination.contactDetails.firstName', '');
  const slast  = val(doc, 'shippingInfo.shippingDestination.contactDetails.lastName', '');
  const sj = [sfirst, slast].filter(Boolean).join(' ');
  if (sj) return sj;

  // buyerInfo name?
  const bfirst = val(doc, 'buyerInfo.firstName', '');
  const blast  = val(doc, 'buyerInfo.lastName', '');
  const bj = [bfirst, blast].filter(Boolean).join(' ');
  if (bj) return bj;

  return '';
}

function pickAddress(doc) {
  // prefer a formatted address
  const f1 = val(doc, 'shippingInfo.shippingDestination.formattedAddress', '');
  const f2 = val(doc, 'contact.address.formattedAddress', '');
  const f3 = val(doc, 'billingInfo.address.formattedAddressLine', '');
  const f4 = val(doc, 'address.formattedAddress', ''); // if you ever stored one
  if (f1 || f2 || f3 || f4) return (f1 || f2 || f3 || f4);

  // otherwise join pieces
  const parts = [
    val(doc, 'shippingInfo.shippingDestination.addressLine', ''),
    val(doc, 'shippingInfo.shippingDestination.addressLine2', ''),
    val(doc, 'shippingInfo.shippingDestination.city', ''),
    val(doc, 'shippingInfo.shippingDestination.subdivision', ''),
    val(doc, 'shippingInfo.shippingDestination.postalCode', ''),
    val(doc, 'shippingInfo.shippingDestination.countryFullname', '') || val(doc, 'shippingInfo.shippingDestination.country', '')
  ].filter(Boolean);
  if (parts.length) return parts.join(', ');

  const cparts = [
    val(doc, 'contact.address.addressLine', ''),
    val(doc, 'contact.address.addressLine2', ''),
    val(doc, 'contact.address.city', ''),
    val(doc, 'contact.address.subdivision', ''),
    val(doc, 'contact.address.postalCode', ''),
    val(doc, 'contact.address.country', '')
  ].filter(Boolean);
  if (cparts.length) return cparts.join(', ');

  return '';
}

function pickPhoneFromDoc(doc) {
  // prefer value saved by webhook
  const existing = doc?.customer?.phone;
  if (existing) return existing;

  // try recomputing from any raw-like fields you might have retained
  const p =
    val(doc, 'shippingInfo.shippingDestination.contactDetails.phone', '') ||
    val(doc, 'billingInfo.contactDetails.phone', '') ||
    val(doc, 'contact.phone', '') ||
    val(doc, 'buyerInfo.phone', '');

  const digits = String(p).replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.length === 11 && digits.startsWith('0')) return digits;
  if (digits.length === 10) return '0' + digits;
  if (digits.length === 12 && digits.startsWith('90')) return '0' + digits.slice(2);
  return digits;
}

function pickEmail(doc) {
  return doc?.customer?.email || doc?.buyerEmail || val(doc, 'contact.email', '') || '';
}

function pickLineItemFields(li) {
  if (!li) return { sku:'', name:'', qty:'', unitPrice:'', lineTotal:'', currency:'' };

  const sku = li.sku || li.SKU || li.id || '';
  const name = li.name || li.title || '';
  const qty = Number(li.quantity || li.qty || 1) || 1;

  // unit/total prices (handle a bunch of shapes)
  const lpVal = val(li, 'totalPrice.value', null) ?? val(li, 'price.total.value', null) ?? val(li, 'total.value', null);
  const upVal = val(li, 'unitPrice.value', null) ?? val(li, 'price.unit.value', null) ?? val(li, 'priceBeforeTax.value', null);

  const currency = val(li, 'totalPrice.currency', '') || val(li, 'price.total.currency', '') || val(li, 'unitPrice.currency', '') || '';

  let unitPrice = (typeof upVal === 'number') ? upVal : '';
  let lineTotal = (typeof lpVal === 'number') ? lpVal : '';

  if (lineTotal === '' && unitPrice !== '' && qty) lineTotal = +(unitPrice * qty).toFixed(2);
  if (unitPrice === '' && lineTotal !== '' && qty) unitPrice = +(lineTotal / qty).toFixed(2);

  return { sku, name, qty, unitPrice, lineTotal, currency };
}

function pickOptionValue(li, names = []) {
  // Wix "description lines" / options often appear as an array of { name/title, description/value }
  const lines = li?.descriptionLines || li?.options || li?.customizations || [];
  const arr = Array.isArray(lines) ? lines : [];
  const want = names.map(s => String(s).toLowerCase());
  for (const line of arr) {
    const key = (line.name || line.title || '').toLowerCase();
    if (want.includes(key)) return line.description || line.value || '';
  }
  return '';
}

function pickOrderTotals(doc, liCurrency) {
  // try order-level totals first
  const total = val(doc, 'totals.total.value', null) ?? val(doc, 'priceSummary.total.value', null);
  const disc  = val(doc, 'totals.discount.value', null) ?? val(doc, 'priceSummary.discount.value', null);
  const cur   = val(doc, 'totals.total.currency', '')  || val(doc, 'priceSummary.total.currency', '')  || doc.currency || liCurrency || 'TRY';

  return {
    total: (typeof total === 'number') ? total : '',
    discount: (typeof disc === 'number') ? disc : '',
    currency: cur
  };
}

function pickShipping(doc) {
  const fee = val(doc, 'totals.shipping.value', null) ?? val(doc, 'priceSummary.shipping.value', null);
  return (typeof fee === 'number') ? fee : '';
}

function pickPaymentMethod(doc) {
  // best-effort; many payloads lack provider name in what you saved
  return doc.paymentMethod || doc.paymentProvider || doc.paymentStatus || '';
}

function pickCarrier(doc) { return doc.carrier || ''; }
function pickTracking(doc) { return doc.trackingNumber || ''; }
function pickShippedAt(doc){ return doc.shippedAt ? fmtTRDate(doc.shippedAt) : ''; }
function pickDelivStatus(doc){ return doc.deliveryStatus || ''; }
function pickDeliveredAt(doc){ return doc.deliveredAt ? fmtTRDate(doc.deliveredAt) : ''; }

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).send('GET only — orders-flat');
    }

    const key = req.query.key || '';
    const expected = process.env.EXPORT_KEY || process.env.ORDERS_EXPORT_KEY || process.env.WIX_EXPORT_KEY || '';
    if (!expected || key !== expected) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const rows = await withDb(async (db) => {
      const col = db.collection('orders');
      const docs = await col.find({}).sort({ createdAt: -1, _id: -1 }).toArray();

      return docs.map(doc => {
        const li = firstItem(doc);
        const { sku, name, qty, unitPrice, lineTotal, currency: liCurrency } = pickLineItemFields(li);
        const { total: orderTotal, discount, currency: orderCur } = pickOrderTotals(doc, liCurrency);

        const row = [];

        // 1..3
        row.push(doc.orderNumber || '');
        row.push(fmtTRDate(doc.createdAt));
        row.push(doc.channel || 'wix');

        // 4..9 supplier editable block -> leave blank; Apps Script preserves edits anyway
        row.push(''); row.push(''); row.push(''); row.push(''); row.push(''); row.push('');

        // 10 DHL ref
        row.push(doc.dhlRef || '');

        // 11..12 customer name + address
        row.push(pickName(doc));
        row.push(pickAddress(doc));

        // 13..17 line item basics
        row.push(sku);
        row.push(name);
        row.push(qty);
        row.push(unitPrice);
        row.push(lineTotal);

        // 18..22 options
        row.push(pickOptionValue(li, ['Beden', 'Size']));
        row.push(pickOptionValue(li, ['Cinsiyet', 'Gender']));
        row.push(pickOptionValue(li, ['Renk', 'Color']));
        row.push(pickOptionValue(li, ['Telefon Modeli', 'Phone Model']));
        row.push(pickOptionValue(li, ['Tablo Boyutu', 'Canvas Size', 'Boyut']));

        // 23..24 payment + shipping fee
        row.push(pickPaymentMethod(doc));
        row.push(pickShipping(doc));

        // 25..29 shipping tracking/status
        row.push(pickCarrier(doc));
        row.push(pickTracking(doc));
        row.push(pickShippedAt(doc));
        row.push(pickDelivStatus(doc));
        row.push(pickDeliveredAt(doc));

        // 30..35 totals, currency, notes, email, phone
        row.push(orderTotal);
        row.push(discount);
        row.push(orderCur || liCurrency || doc.currency || 'TRY');
        row.push(doc.notes || '');
        row.push(pickEmail(doc));
        row.push(pickPhoneFromDoc(doc));

        return row;
      });
    });

    return res.json({
      ok: true,
      headers: HEADERS,
      rows
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
