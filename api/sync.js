// Expose orders table for Google Sheets Apps Script
const { getDB } = require('../lib/db');

const HEADERS = [
  'Sipariş No','Sipariş Tarihi','Sipariş Kanalı',
  'Tedarikçi Adı','Tedarikçi Sipariş No','Tedarikçi Kargo Firması','Tedarikçi Kargo Takip No',
  'Tedarikçiye Veriliş Tarihi','Tedarikçiden Teslim Tarihi',
  'DHL Referans No','Müşteri Adı','Adres','SKU','Ürün','Adet','Birim Fiyat','Ürün Toplam Fiyat',
  'Beden','Cinsiyet','Renk','Telefon Modeli','Tablo Boyutu',
  'Ödeme Yöntemi','Kargo Ücreti','Kargo Firması','Kargo Takip No',
  'Kargoya Veriliş Tarihi','Teslimat Durumu','Teslimat Tarihi',
  'Sipariş Toplam Fiyat','İndirim (₺)','Para Birimi','Notlar','E-posta','Telefon'
];

function fmtDate(d) {
  if (!d) return '';
  return new Intl.DateTimeFormat('tr-TR',{timeZone:'Europe/Istanbul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(d));
}
function safe(v) { return v ?? ''; }
function money(n) { return Number(Number(n||0).toFixed(2)); }

module.exports = async (req, res) => {
  try {
    const db = await getDB();
    const docs = await db.collection('orders').find({}).sort({ createdAt: -1 }).toArray();

    const rows = [];
    for (const o of docs) {
      const items = o.items?.length ? o.items : [{sku:'',name:'',qty:1,unitPrice:0,variants:{}}];
      for (const it of items) {
        rows.push([
          o.orderNumber,
          fmtDate(o.createdAt),
          o.channel || 'wix',
          '', '', '', '', '', '',
          o.delivery?.referenceId || o.delivery?.referenceIdPlaceholder || '',
          o.customer?.name || '',
          [o.address?.line1,o.address?.line2,`${o.address?.postalCode||''} ${o.address?.city||''}`,o.address?.country||''].filter(Boolean).join(' / '),
          it.sku, it.name, it.qty,
          money(it.unitPrice), money(it.qty * it.unitPrice),
          it.variants?.tshirtSize || '',
          it.variants?.gender || '',
          it.variants?.color || '',
          it.variants?.phoneModel || '',
          it.variants?.portraitSize || '',
          o.payment?.method || 'paytr',
          money(o.totals?.shipping), o.delivery?.courier || '',
          o.delivery?.trackingNumber || '',
          fmtDate(o.delivery?.cargoDispatchDate),
          o.delivery?.status || 'pending',
          fmtDate(o.delivery?.dateDelivered),
          money(o.totals?.grandTotal), money(o.totals?.discount), o.totals?.currency || 'TRY',
          o.notes || '', o.customer?.email || '', o.customer?.phone || ''
        ]);
      }
    }

    res.json({ ok: true, headers: HEADERS, rows });
  } catch (err) {
    console.error('sync error', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
