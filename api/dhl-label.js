// /api/dhl-label.js
export default async function handler(req, res) {
  try {
    const { ref } = req.query;
    if (!ref) return res.status(400).json({ ok: false, error: 'Missing ref' });

    // 1) Get token (re-use your existing helper if you have one)
    const tokenResp = await fetch(process.env.DHL_GET_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerNumber: process.env.DHL_CUSTOMER_NUMBER,
        password: process.env.DHL_CUSTOMER_PASSWORD,
        identityType: process.env.DHL_IDENTITY_TYPE || 1
      })
    });
    if (!tokenResp.ok) {
      const t = await tokenResp.text();
      return res.status(502).json({ ok: false, error: 'Token failed', detail: t });
    }
    const { data: tokenData } = await tokenResp.json(); // matches your create/track code shape
    const accessToken = tokenData?.access_token || tokenData?.token || tokenData;

    // 2) Call label endpoint (adjust URL/shape to your MNG label API)
    // Example variable name — set this in Vercel Project → Settings → Environment Variables
    const labelUrl = process.env.DHL_PRINT_LABEL_URL; 
    if (!labelUrl) return res.status(500).json({ ok: false, error: 'DHL_PRINT_LABEL_URL not set' });

    const labelResp = await fetch(labelUrl, {
      method: 'POST', // or GET if your API wants ?referenceId=
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ referenceId: ref }) // adjust to API contract
    });

    if (!labelResp.ok) {
      const lt = await labelResp.text();
      return res.status(502).json({ ok: false, error: 'Label fetch failed', detail: lt });
    }

    // Assume API returns base64 string for the PDF, e.g. { data: "<base64>" }
    const labelJson = await labelResp.json();
    const pdfBase64 = labelJson?.data || labelJson?.pdfBase64;
    if (!pdfBase64) return res.status(500).json({ ok: false, error: 'No PDF in response' });

    return res.status(200).json({ ok: true, fileName: ref, pdfBase64 });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
