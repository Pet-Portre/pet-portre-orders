// Returns headers + rows for Google Sheets
// Reads from MongoDB collection: "orders"

const { connectToDatabase } = require('../lib/db');

// Header list (TR [EN]) — row order matters
const HEADERS = [
  // A) Store (Wix)
  'Sipariş No',                 // [Order No]
  'Sipariş Tarihi',             // [Order Date]
  'Sipariş Kanalı',             // [Sales Channel]
  'Müşteri Adı',                // [Customer Name]
  'Adres',                      // [Address]
  'SKU',                        // [SKU]
  'Ürün',                       // [Product]
  'Adet',                       // [Quantity]
  'Birim Fiyat',                // [Unit Price]
  'Ürün Toplam Fiyat',          // [Product Line Total]
  'Beden',                      // [Size]
  'Cinsiyet',                   // [Gender]
  'Renk',                       // [Color]
  'Telefon Modeli',             // [Phone Model]
  'Tablo Boyutu',               // [Canvas Size]
  'Ödeme Yöntemi',              // [Payment Method]
  'Sipariş Toplam Fiyat',       // [Order Total]
  'İndirim (₺)',                // [Discount]
  'Para Birimi',                // [Currency]
  'E-posta',                    // [Email]
  'Telefon',                    // [Phone]

  // B) Supplier (internal/inbound)
  'Tedarikçi Adı',              // [Supplier Name]
  'Tedarikçi Sipariş No',       // [Supplier PO No]
  'Tedarikçi Kargo Firması',    // [Supplier Carrier]
  'Tedarikçi Kargo Takip No',   // [Supplier Tracking No]
  'Tedarikçiye Veriliş Tarihi', // [Date Given to Supplier]
  'Tedarikçiden Teslim Tarihi', // [Date Received from Supplier]

  // C) Customer shipping (MNG)
  'Kargo Firması',              // [Carrier]
  'Kargo Takip No',             // [Tracking No]
  'Kargoya Veriliş Tarihi',     // [Handed to Carrier Date]
  'Teslimat Durumu',            // [Delivery Status]
  'Teslimat Tarihi',            // [Delivery Date]
  'DHL Referans No',            // [Carrier Reference / Our Reference]

  // D) Cost / notes
  'Kargo Ücreti',               // [Shipping Cost]
  'Notlar'                      // [Notes]
];

// Helper to read nested props safely
const g = (obj, path, fallback = '') => {
  try {
    return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj) ?? fallback;
  } catch {
    return fallback;
  }
};

module.exports = async (req, res) => {
  try {
    const { db } = await connectToDatabase();
    const col = db.collection('orders'); // collection name

    // You can filter/limit here if you like
    const docs = await col.find({}).sort({ createdAt: -1 }).limit(1000).toArray();

    // Map docs -> rows matching HEADERS order
    const rows = docs.map((d) => ([
      // A) Wix
      g(d, 'orderNo'),                           // Sipariş No
      g(d, 'orderDate'),                         // Sipariş Tarihi
      g(d, 'channel'),                           // Sipariş Kanalı
      g(d, 'customer.name') || g(d, 'customerName'), // Müşteri Adı
      g(d, 'shipping.address') || g(d, 'address'),   // Adres
      g(d, 'item.sku') || g(d, 'sku'),           // SKU
      g(d, 'item.name') || g(d, 'product'),      // Ürün
      g(d, 'item.qty') || g(d, 'quantity'),      // Adet
      g(d, 'item.unitPrice') || g(d, 'unitPrice'),   // Birim Fiyat
      g(d, 'item.lineTotal') || g(d, 'lineTotal'),   // Ürün Toplam Fiyat
      g(d, 'options.size') || g(d, 'size'),      // Beden
      g(d, 'options.gender') || g(d, 'gender'),  // Cinsiyet
      g(d, 'options.color') || g(d, 'color'),    // Renk
      g(d, 'options.phoneModel') || g(d, 'phoneModel'), // Telefon Modeli
      g(d, 'options.canvasSize') || g(d, 'canvasSize'), // Tablo Boyutu
      g(d, 'payment.method') || g(d, 'paymentMethod'),  // Ödeme Yöntemi
      g(d, 'totals.orderTotal') || g(d, 'orderTotal'),  // Sipariş Toplam Fiyat
      g(d, 'totals.discount') || g(d, 'discount'),      // İndirim (₺)
      g(d, 'currency') || 'TRY',                    // Para Birimi
      g(d, 'customer.email') || g(d, 'email'),      // E-posta
      g(d, 'customer.phone') || g(d, 'phone'),      // Telefon

      // B) Supplier
      g(d, 'supplier.name'),                        // Tedarikçi Adı
      g(d, 'supplier.poNumber'),                    // Tedarikçi Sipariş No
      g(d, 'supplier.carrier'),                     // Tedarikçi Kargo Firması
      g(d, 'supplier.trackingNo'),                  // Tedarikçi Kargo Takip No
      g(d, 'supplier.handedAt'),                    // Tedarikçiye Veriliş Tarihi
      g(d, 'supplier.receivedAt'),                  // Tedarikçiden Teslim Tarihi

      // C) Customer shipping (MNG)
      g(d, 'shipping.carrier') || 'MNG Kargo',      // Kargo Firması
      g(d, 'shipping.trackingNo') || g(d, 'trackingNo'), // Kargo Takip No
      g(d, 'shipping.handedAt'),                    // Kargoya Veriliş Tarihi
      g(d, 'shipping.deliveryStatus'),              // Teslimat Durumu
      g(d, 'shipping.deliveryDate'),                // Teslimat Tarihi
      g(d, 'shipping.referenceId') || g(d, 'dhlRef') || g(d, 'referenceId'), // DHL Referans No

      // D) Cost / notes
      g(d, 'shipping.cost') || g(d, 'shippingCost'), // Kargo Ücreti
      g(d, 'notes')                                  // Notlar
    ]));

    res.setHeader('content-type', 'application/json');
    res.status(200).end(JSON.stringify({
      ok: true,
      headers: HEADERS,
      rows
    }));
  } catch (err) {
    console.error('sync error:', err);
    res.status(200).json({ ok: false, error: String(err && err.message || err) });
  }
};
