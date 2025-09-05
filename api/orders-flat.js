// api/orders-flat.js
const { withDb } = require('../lib/db');

// Turkish headers expected by your Google Sheet
const HEADERS = [
  'Sipariş No',
  'Sipariş Tarihi',
  'Sipariş Kanalı',
  'Tedarikçi Adı',
  'DHL Referans No',
  'Müşteri Adı',
  'Adres',
  'İl',
  'İlçe',
  'Posta Kodu',
  'Telefon',
  'E-posta',
  'Kargo Firması',
  'Kargo Takip No',
  'Kargoya Veriliş Tarihi',
  'Teslimat Durumu',
  'Teslimat Tarihi',
  'Kargo Etiket PDF',     // sheet fills this after label print
  'SKU',
  'Ürün',
  'Birim Fiyat',
  'Ürün Toplam Fiyat',
  'Notlar'
];

// ---------- helpers ----------
function first(arr, field, fallback = '') {
  if (!Array.isArray(arr) || !arr.length) return fallback;
  const v = arr[0]?.[field];
  return v == null ? fallback : v;
}
function joinAddr(c) {
  if (!c) return '';
  const a1 = c.addrLine1 || c.address || '';
  const a2 = c.addrLine2 || '';
  return [a1, a2].filter(Boolean).join(' ');
}
function getCity(doc) {
  const c = doc.customer || {};
  return c.city || c.address?.city || '';
}
function getDistrict(doc) {
  const c = doc.customer || {};
  return c.district || c.address?.district || '';
}
function getPostcode(doc) {
  const c = doc.customer || {};
  return c.postcode || c.postalCode || c.address?.postcode || '';
}
function normStatus(s) {
  if (!s) return 'Bekliyor';
  const v = String(s).toLowerCase();
  if (v.includes('deliver')) return 'Teslim Edildi';
  if (v.includes('create') || v.includes('label')) return 'CREATED';
  if (v.includes('ship') || v.includes('transit')) return 'Kargoda';
  return s;
}
// --------------------------------

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).send('GET only — orders-flat');
    }

    // accept either env var name for compatibility
    const exportSecret = process.env.EXPORT_KEY || process.env.EXPORT_TOKEN;
    const key = req.query.key || req.headers['x-api-key'] || '';
    if (!exportSecret || key !== exportSecret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const supplier = process.env.SUPPLIER_NAME || 'tom flatman';

    const rows = await withDb(async (db) => {
      const docs = await db.collection('orders')
        .find({})
        .sort({ createdAt: -1 })
        .limit(5000)
        .toArray();

      return docs.map(d => {
        const items = Array.isArray(d.items) ? d.items : [];
        const totals = d.totals || {};

        return [
          d.orderNumber || '',
          d.createdAt ? new Date(d.createdAt).toISOString() : '',
          d.channel || 'wix',
          supplier,
          d.dhlRef || d.referenceId || '',
          d.customer?.name || '',
          joinAddr(d.customer),
          getCity(d),
          getDistrict(d),
          getPostcode(d),
          d.customer?.phone || '',
          d.customer?.email || '',
          d.carrier || '',
          d.trackingNumber || '',
          d.shippedAt || '',
          normStatus(d.status) || '',
          d.deliveredAt || '',
          '',                                // Kargo Etiket PDF (filled by Sheet)
          first(items, 'sku', ''),
          first(items, 'name', ''),
          Number(first(items, 'unitPrice', 0)) || 0,
          Number(totals.total ?? 0) || 0,
          d.notes || ''
        ];
      });
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json({ ok: true, headers: HEADERS, rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
