// /api/returns/webhook-sheet.js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok:false, error:"method_not_allowed" });

  const token = req.headers["x-admin-token"];
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(403).json({ ok:false, error:"forbidden" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
  if (!body.referenceId) {
    return res.status(200).json({ ok:false, error:"missing_referenceId" });
  }

  // Pretend Sheet pushed update
  return res.status(200).json({
    ok:true,
    referenceId:body.referenceId,
    received:true,
    echoed:body
  });
}
