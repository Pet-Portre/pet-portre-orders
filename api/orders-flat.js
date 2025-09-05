// api/orders-flat.js
// Export orders in your exact TR header order for Google Sheets

const { withDb } = require('../lib/db');

function n(v) { const x = Number(v); return Number.isFinite(x) ? x : ''; }
function fmtIso(v) { try { return new Date(v).toISOString(); } catch { return ''; } }
function truthy(v) { return v != null && v !== ''; }

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

function rowFromDoc(d) {
  const it = d.firstItem || {};
  const attrs = it.attributes || {};
  const currency =
    it.currency ||
    d?.totals?.currency ||
    d?.shipping?.currency ||
    'TRY';

  // compute
  const qty = Number(it.quantity) || (it.lineTotal && it.unitPrice ? Math.round(it.lineTotal / it.unitPrice) : 1);
  const unit = truthy(it.unitPrice) ? it.unitPrice : (qty ? Math.round(((Number(it.lineTotal)||0) / qty) * 100)/100 : '');

  // Status placeholders (DHL track can fill later)
  const initialStatus = d?.deliveryStatus || 'Bekliyor';

  return [
    // 1–3
    d.orderNumber || '',
    fmtIso(d.createdAt || ''),
    (d.channel || 'wix').toString().toLowerCase(),

    // 4–9 (supplier: editable in sheets; exporter leaves blank)
    '', '', '', '', '', '',

    // 10 DHL ref (editable in sheets; you can paste or created by your "Create DHL" flow)
    d.dhlRef || '',

    // 11–12 customer & address
    (d.customer?.name || '').trim(),
    (d.address?.full || '').trim(),

    // 13–17 item
    it.sku || '',
    it.name || '',
    n(qty),
    n(unit),
    n(it.lineTotal),

    // 18–22 attributes
    attrs.beden || '',
    attrs.cinsiyet || '',
    attrs.renk || '',
    attrs.telefonModeli || '',
    attrs.tabloBoyutu || '',

    // 23–24 payment & shipping fee
    (d.payment?.method || '').toString(),
    n(d.shipping?.amount),

    // 25–29 shipping/tracking (placeholders unless you fill via DHL endpoints)
    d.carrier || d.shipping?.carrier || 'DHL',
    d.trackingNumber || '',
    d.shippedAt ? fmtIso(d.shippedAt) : '',
    initialStatus,
    d.deliveredAt ? fmtIso(d.deliveredAt) : '',

    // 30–35 order totals, currency, notes, contacts
    n(d.totals?.orderTotal),
    n(d.totals?.discountTotal),
    currency,
    (d.notes || '').toString(),
    d.customer?.email || '',
    d.customer?.phone || ''
  ];
}

module.exports = async (req, res) => {
  try {
    // simple token guard
    const key = (req.query.key || '').toString();
    if (!process.env.EXPORT_TOKEN || key !== process.env.EXPORT_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const docs = await withDb(async (db) => {
      const col = db.collection('orders');
      return col.find({}, { projection: { _raw: 0 } })
        .sort({ createdAt: -1 })
        .limit(1000)
        .toArray();
    });

    const rows = docs.map(rowFromDoc);
    return res.json({ ok: true, headers: HEADERS, rows });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
