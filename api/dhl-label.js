// Fetches a PDF label from MNG's label endpoint, returns base64
export default async function handler(req, res) {
  try {
    const ref = (req.query?.ref || "").toString();
    if (!ref) return res.status(400).json({ ok: false, error: "ref required" });

    const url = process.env.DHL_LABEL_URL_PROD || process.env.DHL_LABEL_URL;
    if (!url) return res.status(500).json({ ok: false, error: "DHL_LABEL_URL missing" });

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ referenceId: ref })
    });

    if (!resp.ok) {
      const t = await resp.text();
      return res.status(resp.status).json({ ok: false, error: `Label API ${resp.status}: ${t}` });
    }

    // Assume endpoint returns PDF bytes
    const buf = Buffer.from(await resp.arrayBuffer());
    const pdfBase64 = buf.toString("base64");

    return res.status(200).json({
      ok: true,
      fileName: `label-${ref}`,
      pdfBase64
    });
  } catch (e) {
    console.error("dhl-label error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
