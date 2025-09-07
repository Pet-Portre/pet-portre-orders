// /api/returns/public.js
export default async function handler(req, res) {
  const { code } = req.query; // ?code=RET1234
  if (!code) return res.status(200).json({ ok:false, error:"missing_code" });

  // pretend every code ending with even number is still valid
  const expired = parseInt(code.slice(-1)) % 2 === 1;

  if (expired) {
    return res.status(200).json({ ok:true, state:"expired", referenceId:code });
  }

  return res.status(200).json({
    ok:true,
    state:"found",
    referenceId:code,
    status:"awaiting_dropoff",
    expiresAt:"2025-09-21",
    instructions:"Ürünü güvenli şekilde paketleyin ve iade kodunuzla MNG/DHL noktasına teslim edin."
  });
}
