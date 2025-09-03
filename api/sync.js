// api/sync.js
import { getDb } from "../lib/db.js";

/**
 * Column order for row 2 (headers) — EXACTLY what your Sheet expects.
 * (DHL Referans No is placed before “Müşteri Adı” just like your previous sheet.)
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

function okDash(v) {
  // For certain cells we prefer an en-dash instead of empty string
  return v === undefined || v === null || v === "" ? "–" : v;
}
function maybe(v) {
  // For free text columns we prefer empty string when missing
  return v === undefined || v === null ? "" : v;
}
function fmtDate(d, includeTime = false) {
  if (!d) return "–";
  try {
    const dt = typeof d === "string" ? new Date(d) : d;
    const tz = "Europe/Istanbul";
    const opt = includeTime
      ? { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }
      : { year: "numeric", month: "2-digit", day: "2-digit" };
    const s = new Intl.DateTimeFormat("tr-TR", { timeZone: tz, ...opt }).format(dt);
    // normalize to YYYY-MM-DD or YYYY-MM-DD HH:mm
    const [dd, mm, yyyy, hhmm] = s.match(/\d+/g) || [];
    if (includeTime) return `${yyyy}-${mm}-${dd} ${hhmm.slice(0,2)}:${hhmm.slice(2)}`;
    return `${yyyy}-${mm}-${dd}`;
  } catch {
    return "–";
  }
}

function makeRowsFromOrder(doc) {
  // fallbacks
  const channel = maybe(doc.channel || "wix");
  const orderNo = maybe(doc.orderNumber);
  const createdAt = fmtDate(doc.createdAt, true);

  const supplier = doc.supplier || {};
  const delivery  = doc.delivery || {};
  const customer  = doc.customer || {};
  const totals    = doc.totals || {};
  const payment   = doc.payment || {};
  const notes     = maybe(doc.notes);

  // DHL reference — official first, else placeholder, else en-dash
  const dhlRef =
    okDash(delivery.referenceId) !== "–"
      ? delivery.referenceId
      : okDash(delivery.referenceIdPlaceholder) !== "–"
        ? delivery.referenceIdPlaceholder
        : "–";

  // line items: 1 row per item
  const items = Array.isArray(doc.items) && doc.items.length ? doc.items : [ { qty: 1 } ];

  const rows = items.map((it) => {
    const v = it.variants || {};
    const unitPrice = Number(it.unitPrice ?? 0);
    const qty = Number(it.qty ?? 1);
    const lineTotal = Math.round((qty * unitPrice) * 100) / 100;

    return [
      // order basics
      orderNo,
      createdAt,
      channel,

      // supplier
      okDash(supplier.name),
      okDash(supplier.orderId),
      okDash(supplier.cargoCompany),
      okDash(supplier.cargoTrackingNo),
      fmtDate(supplier.givenAt),
      fmtDate(supplier.receivedAt),

      // DHL
      dhlRef,

      // customer & address
      maybe(customer.name),
      maybe(customer.address?.line1),

      // line item
      maybe(it.sku),
      maybe(it.name),
      qty,
      Math.round(unitPrice * 100) / 100,
      lineTotal,

      // variants
      okDash(v.tshirtSize),
      okDash(v.gender),
      okDash(v.color),
      okDash(v.phoneModel),
      okDash(v.portraitSize),

      // payment & shipping
      maybe(payment.method || "paytr"),
      Math.round(Number(totals.shipping ?? 0) * 100) / 100,
      maybe(delivery.courier || "MNG Kargo"),
      okDash(delivery.trackingNumber),
      fmtDate(delivery.cargoDispatchDate),
      okDash(delivery.status),
      fmtDate(delivery.dateDelivered),

      // totals & misc
      Math.round(Number(totals.grandTotal ?? 0) * 100) / 100,
      Math.round(Number(totals.discount ?? 0) * 100) / 100,
      maybe(totals.currency || "TRY"),
      notes,
      maybe(customer.email),
      maybe(customer.phone),
    ];
  });

  return rows;
}

function isAuthorized(req) {
  // optional guard: set SYNC_TOKEN in Vercel env and append ?token=... from Apps Script if you want
  const token = process.env.SYNC_TOKEN;
  if (!token) return true;
  const q = new URL(req.url, "http://local").searchParams;
  return q.get("token") === token;
}

export default async function handler(req, res) {
  try {
    if (!isAuthorized(req)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "method not allowed" });
    }

    const db = await getDb();
    const col = db.collection("orders");

    // Pull all orders (newest first so your latest appear at the top in Sheets after paste)
    const docs = await col
      .find({}, { sort: { createdAt: -1 } })
      .toArray();

    const rows = [];
    for (const d of docs) {
      const r = makeRowsFromOrder(d);
      rows.push(...r);
    }

    return res.status(200).json({ ok: true, headers: HEADERS, rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message || "internal error" });
  }
}
