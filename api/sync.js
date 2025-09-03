import { getDb } from "../lib/db";

/**
 * Headers in the order your Sheet uses (row 2).
 * “DHL Referans No” is placed before “Müşteri Adı” as you requested.
 */
const HEADERS = [
  "Sipariş No","Sipariş Tarihi","Sipariş Kanalı",
  "Tedarikçi Adı","Tedarikçi Sipariş No","Tedarikçi Kargo Firması","Tedarikçi Kargo Takip No",
  "Tedarikçiye Veriliş Tarihi","Tedarikçiden Teslim Tarihi",
  "DHL Referans No",
  "Müşteri Adı","Adres",
  "SKU","Ürün","Adet","Birim Fiyat","Ürün Toplam Fiyat",
  "Beden","Cinsiyet","Renk","Telefon Modeli","Tablo Boyutu",
  "Ödeme Yöntemi","Kargo Ücreti","Kargo Firması","Kargo Takip No",
  "Kargoya Veriliş Tarihi","Teslimat Durumu","Teslimat Tarihi",
  "Sipariş Toplam Fiyat","İndirim (₺)","Para Birimi","Notlar","E-posta","Telefon"
];

const EN_DASH = "–";

export default async function handler(req, res) {
  try {
    const db = await getDb();

    // One row per line item
    const rows = await db.collection("orders").aggregate([
      { $unwind: { path: "$items", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          // order basics
          "Sipariş No": "$orderNumber",
          "Sipariş Tarihi": {
            $cond: [
              { $ifNull: ["$createdAt", false] },
              { $dateToString: { date: "$createdAt", format: "%Y-%m-%d %H:%M", timezone: "Europe/Istanbul" } },
              EN_DASH
            ]
          },
          "Sipariş Kanalı": "$channel",

          // supplier block (optional)
          "Tedarikçi Adı": { $ifNull: ["$supplier.name", EN_DASH] },
          "Tedarikçi Sipariş No": { $ifNull: ["$supplier.orderId", EN_DASH] },
          "Tedarikçi Kargo Firması": { $ifNull: ["$supplier.cargoCompany", EN_DASH] },
          "Tedarikçi Kargo Takip No": { $ifNull: ["$supplier.cargoTrackingNo", EN_DASH] },
          "Tedarikçiye Veriliş Tarihi": {
            $cond: [
              { $ifNull: ["$supplier.givenAt", false] },
              { $dateToString: { date: "$supplier.givenAt", format: "%Y-%m-%d", timezone: "Europe/Istanbul" } },
              EN_DASH
            ]
          },
          "Tedarikçiden Teslim Tarihi": {
            $cond: [
              { $ifNull: ["$supplier.receivedAt", false] },
              { $dateToString: { date: "$supplier.receivedAt", format: "%Y-%m-%d", timezone: "Europe/Istanbul" } },
              EN_DASH
            ]
          },

          // DHL Referans logic: prefer official, else placeholder, else en-dash
          "DHL Referans No": {
            $cond: [
              { $and: [
                { $ne: ["$delivery.referenceId", null] },
                { $ne: ["$delivery.referenceId", ""] }
              ]},
              "$delivery.referenceId",
              {
                $cond: [
                  { $and: [
                    { $ne: ["$delivery.referenceIdPlaceholder", null] },
                    { $ne: ["$delivery.referenceIdPlaceholder", ""] }
                  ]},
                  "$delivery.referenceIdPlaceholder",
                  EN_DASH
                ]
              }
            ]
          },

          // customer
          "Müşteri Adı": { $ifNull: ["$customer.name", ""] },
          "Adres": {
            $trim: {
              input: {
                $concat: [
                  { $ifNull: ["$customer.address.line1", ""] },
                  " ",
                  { $ifNull: ["$customer.address.city", ""] },
                  " ",
                  { $ifNull: ["$customer.address.postcode", ""] }
                ]
              }
            }
          },

          // line item
          "SKU": "$items.sku",
          "Ürün": "$items.name",
          "Adet": "$items.qty",
          "Birim Fiyat": { $round: ["$items.unitPrice", 2] },
          "Ürün Toplam Fiyat": { $round: [{ $multiply: ["$items.qty", "$items.unitPrice"] }, 2] },

          // variants
          "Beden": { $ifNull: ["$items.variants.tshirtSize", EN_DASH] },
          "Cinsiyet": { $ifNull: ["$items.variants.gender", EN_DASH] },
          "Renk": { $ifNull: ["$items.variants.color", EN_DASH] },
          "Telefon Modeli": { $ifNull: ["$items.variants.phoneModel", EN_DASH] },
          "Tablo Boyutu": { $ifNull: ["$items.variants.portraitSize", EN_DASH] },

          // payment, delivery
          "Ödeme Yöntemi": { $ifNull: ["$payment.method", "paytr"] },
          "Kargo Ücreti": { $round: [{ $ifNull: ["$totals.shipping", 0] }, 2] },
          "Kargo Firması": { $ifNull: ["$delivery.courier", EN_DASH] },
          "Kargo Takip No": {
            $cond: [
              { $and: [
                { $ne: ["$delivery.trackingNumber", null] },
                { $ne: ["$delivery.trackingNumber", ""] }
              ]},
              "$delivery.trackingNumber",
              EN_DASH
            ]
          },
          "Kargoya Veriliş Tarihi": {
            $cond: [
              { $ifNull: ["$delivery.cargoDispatchDate", false] },
              { $dateToString: { date: "$delivery.cargoDispatchDate", format: "%Y-%m-%d", timezone: "Europe/Istanbul" } },
              EN_DASH
            ]
          },
          "Teslimat Durumu": { $ifNull: ["$delivery.status", EN_DASH] },
          "Teslimat Tarihi": {
            $cond: [
              { $ifNull: ["$delivery.dateDelivered", false] },
              { $dateToString: { date: "$delivery.dateDelivered", format: "%Y-%m-%d", timezone: "Europe/Istanbul" } },
              EN_DASH
            ]
          },

          // totals & misc
          "Sipariş Toplam Fiyat": { $round: [{ $ifNull: ["$totals.grandTotal", 0] }, 2] },
          "İndirim (₺)": { $round: [{ $ifNull: ["$totals.discount", 0] }, 2] },
          "Para Birimi": {
            $cond: [
              { $or: [
                { $eq: ["$totals.currency", null] },
                { $eq: ["$totals.currency", ""] }
              ]},
              "TRY",
              "$totals.currency"
            ]
          },
          "Notlar": { $ifNull: ["$notes", ""] },
          "E-posta": { $ifNull: ["$customer.email", ""] },
          "Telefon": { $ifNull: ["$customer.phone", ""] }
        }
      },
      { $sort: { createdAt: -1, orderNumber: -1 } }
    ]).toArray();

    const orderedRows = rows.map(row => HEADERS.map(h => (row[h] ?? "")));
    return res.status(200).json({ ok: true, headers: HEADERS, rows: orderedRows });
  } catch (e) {
    console.error("sync error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
