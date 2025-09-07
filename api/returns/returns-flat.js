// /api/returns-flat.js
// Stub endpoint for Google Sheets export of Returns
// Requires ?key=EXPORT_TOKEN

export default async function handler(req, res) {
  const { key } = req.query;
  if (key !== process.env.EXPORT_TOKEN) {
    return res.status(403).json({ ok: false, error: "forbidden" });
  }

  const headers = [
    "İade Kodu",
    "Sipariş No",
    "E-posta",
    "Durum",
    "Genel Sebep",
    "Ürünler (CSV)",
    "Not",
    "Müşteri Fotoğrafları (CSV)",
    "Talep Tarihi",
    "Güncelleme Tarihi",
    "Taşıyıcı",
    "İade Etiket PDF",
    "Müşteri Talimatları",
    "Dış Takip Linki",
  ];

  // stubbed rows
  const rows = [
    [
      "RET1234",
      "10001",
      "customer@example.com",
      "INITIATED",
      "Ürün olmadı / Beden uymadı",
      "SKU123 x1",
      "Ad: Ali Veli — Ürün bedeni küçük geldi",
      "",
      "2025-09-07",
      "2025-09-07",
      "MNG",
      "https://example.com/label.pdf",
      "Ürünü güvenli şekilde paketleyin ve kodunuzla teslim edin.",
      "https://example.com/track",
    ],
  ];

  return res.status(200).json({
    ok: true,
    headers,
    rows,
    syncedAt: new Date().toISOString(),
  });
}
