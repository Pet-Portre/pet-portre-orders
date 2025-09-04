// api/sync.js
const getDb = require('../lib/db');

const HEADERS = [
  'Sipariş No', 'Sipariş Tarihi', 'Sipariş Kanalı',
  'Tedarikçi Adı', 'Tedarikçi Sipariş No', 'Tedarikçi Kargo Firması', 'Tedarikçi Kargo Takip No',
  'Tedarikçiye Veriliş Tarihi', 'Tedarikçiden Teslim Tarihi',
  'DHL Referans No',
  'Müşteri Adı', 'Adres',
  'SKU', 'Ürün', 'Adet', 'Birim Fiyat', 'Ürün Toplam Fiyat',
  'Beden', 'Cinsiyet', 'Renk', 'Telefon Modeli', 'Tablo Boyutu',
  'Ödeme Yöntemi', 'Kargo Ücreti', 'Kargo Firması', 'Kargo Takip No',
  'Kargoya Veriliş Tarihi', 'Teslimat Durumu', 'Teslimat Tarihi',
  'Sipariş Toplam Fiyat', 'İndirim (₺)', 'Para Birimi', 'Notlar', 'E-posta', 'Telefon'
];

module.exports = async (req, res) => {
  try {
    const db = await getDb();

    const rows = await db.collection('orders').aggregate([
      { $unwind: { path: '$items', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          // order basics
          'Sipariş No': '$orderNumber',
          'Sipariş Tarihi': {
            $cond: [
              { $ifNull: ['$createdAt', false] },
              { $dateToString: { date: '$createdAt', format: '%Y-%m-%d %H:%M', timezone: 'Europe/Istanbul' } },
              ''
            ]
          },
          'Sipariş Kanalı': '$channel',

          // supplier
          'Tedarikçi Adı': { $ifNull: ['$supplier.name', '' ] },
          'Tedarikçi Sipariş No': { $ifNull: ['$supplier.orderId', '' ] },
          'Tedarikçi Kargo Firması': { $ifNull: ['$supplier.cargoCompany', '' ] },
          'Tedarikçi Kargo Takip No': { $ifNull: ['$supplier.cargoTrackingNo', '' ] },
          'Tedarikçiye Veriliş Tarihi': {
            $cond: [
              { $ifNull: ['$supplier.givenAt', false] },
              { $dateToString: { date: '$supplier.givenAt', format: '%Y-%m-%d', timezone: 'Europe/Istanbul' } },
              ''
            ]
          },
          'Tedarikçiden Teslim Tarihi': {
            $cond: [
              { $ifNull: ['$supplier.receivedAt', false] },
              { $dateToString: { date: '$supplier.receivedAt', format: '%Y-%m-%d', timezone: 'Europe/Istanbul' } },
              ''
            ]
          },

          // DHL reference (official → placeholder → empty)
          'DHL Referans No': {
            $ifNull: ['$delivery.referenceId', { $ifNull: ['$delivery.referenceIdPlaceholder', '' ] }]
          },

          // customer
          'Müşteri Adı': { $ifNull: ['$customer.name', '' ] },
          'Adres': { $ifNull: ['$customer.address.line1', '' ] },

          // line item
          'SKU': '$items.sku',
          'Ürün': '$items.name',
          'Adet': '$items.qty',
          'Birim Fiyat': { $round: ['$items.unitPrice', 2] },
          'Ürün Toplam Fiyat': {
            $round: [{ $multiply: ['$items.qty', '$items.unitPrice'] }, 2]
          },

          // variants
          'Beden': { $ifNull: ['$items.variants.tshirtSize', '' ] },
          'Cinsiyet': { $ifNull: ['$items.variants.gender', '' ] },
          'Renk': { $ifNull: ['$items.variants.color', '' ] },
          'Telefon Modeli': { $ifNull: ['$items.variants.phoneModel', '' ] },
          'Tablo Boyutu': { $ifNull: ['$items.variants.portraitSize', '' ] },

          // payment & delivery
          'Ödeme Yöntemi': { $ifNull: ['$payment.method', '' ] },
          'Kargo Ücreti': { $round: ['$totals.shipping', 2] },
          'Kargo Firması': { $ifNull: ['$delivery.courier', '' ] },
          'Kargo Takip No': {
            $ifNull: ['$delivery.trackingNumber', '' ]
          },
          'Kargoya Veriliş Tarihi': {
            $cond: [
              { $ifNull: ['$delivery.cargoDispatchDate', false] },
              { $dateToString: { date: '$delivery.cargoDispatchDate', format: '%Y-%m-%d', timezone: 'Europe/Istanbul' } },
              ''
            ]
          },
          'Teslimat Durumu': { $ifNull: ['$delivery.status', '' ] },
          'Teslimat Tarihi': {
            $cond: [
              { $ifNull: ['$delivery.dateDelivered', false] },
              { $dateToString: { date: '$delivery.dateDelivered', format: '%Y-%m-%d', timezone: 'Europe/Istanbul' } },
              ''
            ]
          },

          // totals & misc
          'Sipariş Toplam Fiyat': { $round: ['$totals.grandTotal', 2] },
          'İndirim (₺)': { $round: [{ $ifNull: ['$totals.discount', 0] }, 2] },
          'Para Birimi': {
            $cond: [
              { $or: [{ $eq: ['$totals.currency', null] }, { $eq: ['$totals.currency', ''] }] },
              'TRY',
              '$totals.currency'
            ]
          },
          'Notlar': { $ifNull: ['$notes', '' ] },
          'E-posta': { $ifNull: ['$customer.email', '' ] },
          'Telefon': { $ifNull: ['$customer.phone', '' ] },
        }
      }
    ]).toArray();

    const orderedRows = rows.map(row => HEADERS.map(h => (row[h] ?? '')));

    res.status(200).json({ ok: true, headers: HEADERS, rows: orderedRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
};
