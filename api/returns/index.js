// /api/returns/index.js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"method_not_allowed" });

  const { orderNumber, email } = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  if (!orderNumber || !email) {
    return res.status(200).json({ ok:false, error:"missing_fields" });
  }

  const referenceId = "RET" + String(orderNumber).slice(-4); // fake code
  const expiresAt = new Date(Date.now() + 14*24*60*60*1000).toISOString().slice(0,10);

  return res.status(200).json({
    ok:true,
    created:true,
    referenceId,
    status:"initiated",
    expiresAt,
    instructions:"Ürünü güvenli şekilde paketleyin ve iade kodunuzla MNG/DHL noktasına teslim edin."
  });
}
