// /api/sync.js
// Self-contained to avoid bundling/import issues (“handler is not a function”).
// Uses ESM default export exactly like your working version.

import { MongoClient } from "mongodb";

// Column order for row 2 (headers). “DHL Referans No” is before “Müşteri Adı”.
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

// OPTIONAL: token guard (set SYNC_TOKEN in Vercel env)
function checkAuth(req) {
  const token = process.env.SYNC_TOKEN;
  if (!token) return true;
  const q = new URL(req.url, "http://x").searchParams;
  return q.get("token") === token;
}

export default async function handler(req, res) {
  try {
    if (!checkAuth(req)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "method not allowed" });
    }

    const client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
    // Keep DB name consistent with your Atlas: pet-portre (NOT Pet-Portre-Orders)
    const db = client.db(process.env.MONGODB_DB || "pet-portre");

    // Build rows: one row per line item, with defensive fallbacks so columns aren’t blank
    const rowsAgg = await db.collection("orders").aggregate([
      { $sort: { createdAt: -1 } },
      { $unwind: { path: "$items", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          // order basics
          "Sipariş No": { $ifNull: ["$orderNumber",""] },
          "Sipariş Tarihi": {
            $cond: [
              { $ifNull: ["$createdAt", false] },
              { $dateToString: { date: "$createdAt", format: "%Y-%m-%d %H:%M", timezone: "Europe/Istanbul" } },
              "–"
            ]
          },
          "Sipariş Kanalı": { $ifNull: ["$channel","wix"] },

          // supplier
          "Tedarikçi Adı": { $ifNull: ["$supplier.name","–"] },
          "Tedarikçi Sipariş No": { $ifNull: ["$supplier.orderId","–"] },
          "Tedarikçi Kargo Firması": { $ifNull: ["$supplier.cargoCompany","–"] },
          "Tedarikçi Kargo Takip No": { $ifNull: ["$supplier.cargoTrackingNo","–"] },
          "Tedarikçiye Veriliş Tarihi": {
            $cond: [
              { $ifNull: ["$supplier.givenAt", false] },
              { $dateToString: { date: "$supplier.givenAt", format: "%Y-%m-%d", timezone: "Europe/Istanbul" } },
              "–"
            ]
          },
          "Tedarikçiden Teslim Tarihi": {
            $cond: [
              { $ifNull: ["$supplier.receivedAt", false] },
              { $dateToString: { date: "$supplier.receivedAt", format: "%Y-%m-%d", timezone: "Europe/Istanbul" } },
              "–"
            ]
          },

          // DHL reference: official first, else placeholder, else en-dash
          "DHL Referans No": {
            $let: {
              vars: {
                official: "$delivery.referenceId",
                placeholder: "$delivery.referenceIdPlaceholder"
              },
              in: {
                $cond: [
                  { $and: [
                    { $ne: ["$$official", null] },
                    { $ne: ["$$official", ""] }
                  ]},
                  "$$official",
                  {
                    $cond: [
                      { $and: [
                        { $ne: ["$$placeholder", null] },
                        { $ne: ["$$placeholder", ""] }
                      ]},
                      "$$placeholder",
                      "–"
                    ]
                  }
                ]
              }
            }
          },

          // customer
          "Müşteri Adı": { $ifNull: ["$customer.name",""] },
          "Adres": { $ifNull: ["$customer.address.line1",""] },

          // line item (safe fallbacks)
          "SKU": { $ifNull: ["$items.sku",""] },
          "Ürün": { $ifNull: ["$items.name",""] },
          "Adet": { $ifNull: ["$items.qty", { $literal: 1 }] },
          "Birim Fiyat": { $round: [{ $ifNull: ["$items.unitPrice", 0] }, 2] },
          "Ürün Toplam Fiyat": {
            $round: [{
              $multiply: [
                { $ifNull: ["$items.qty", 1] },
                { $ifNull: ["$items.unitPrice", 0] }
              ]
            }, 2]
          },

          // variants
          "Beden": { $ifNull: ["$items.variants.tshirtSize","–"] },
          "Cinsiyet": { $ifNull: ["$items.variants.gender","–"] },
          "Renk": { $ifNull: ["$items.variants.color","–"] },
          "Telefon Modeli": { $ifNull: ["$items.variants.phoneModel","–"] },
          "Tablo Boyutu": { $ifNull: ["$items.variants.portraitSize","–"] },

          // payment & delivery
          "Ödeme Yöntemi": { $ifNull: ["$payment.method","paytr"] },
          "Kargo Ücreti": { $round: [{ $ifNull: ["$totals.shipping", 0] }, 2] },
          "Kargo Firması": { $ifNull: ["$delivery.courier","MNG Kargo"] },

          // tracking number: force en-dash if blank
          "Kargo Takip No": {
            $cond: [
              { $or: [
                { $eq: ["$delivery.trackingNumber", null] },
                { $eq: ["$delivery.trackingNumber", ""] }
              ]},
              "–",
              "$delivery.trackingNumber"
            ]
          },

          "Kargoya Veriliş Tarihi": {
            $cond: [
              { $ifNull: ["$delivery.cargoDispatchDate", false] },
              { $dateToString: { date: "$delivery.cargoDispatchDate", format: "%Y-%m-%d", timezone: "Europe/Istanbul" } },
              "–"
            ]
          },
          "Teslimat Durumu": { $ifNull: ["$delivery.status","–"] },
          "Teslimat Tarihi": {
            $cond: [
              { $ifNull: ["$delivery.dateDelivered", false] },
              { $dateToString: { date: "$delivery.dateDelivered", format: "%Y-%m-%d", timezone: "Europe/Istanbul" } },
              "–"
            ]
          },

          // totals & misc
          "Sipariş Toplam Fiyat": { $round: [{ $ifNull: ["$totals.grandTotal", 0] }, 2] },
          "İndirim (₺)": { $round: [{ $ifNull: ["$totals.discount", 0] }, 2] },

          // Para Birimi — hard fallback to TRY
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

          "Notlar": { $ifNull: ["$notes",""] },
          "E-posta": { $ifNull: ["$customer.email",""] },
          "Telefon": { $ifNull: ["$customer.phone",""] }
        }
      }
    ]).toArray();

    await client.close();

    // Keep order & shape stable; do not convert "–" to empty string
    const orderedRows = rowsAgg.map(row =>
      HEADERS.map(h => (row[h] !== undefined && row[h] !== null) ? row[h] : "")
    );

    res.status(200).json({ ok: true, headers: HEADERS, rows: orderedRows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || "internal error" });
  }
}
