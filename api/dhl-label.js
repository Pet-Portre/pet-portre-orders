// api/dhl-label.js
// Prints a DHL/MNG label (PDF by default) for a given referenceId.
// Secured with x-api-key header (uses PRINT_LABEL_TOKEN if set, else WIX_WEBHOOK_TOKEN).

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', ['POST']);
      return res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    }

    const apiKey =
      process.env.PRINT_LABEL_TOKEN || process.env.WIX_WEBHOOK_TOKEN || '';
    if (!apiKey || req.headers['x-api-key'] !== apiKey) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const { referenceId, labelType = 'PDF', paperSize = 'A6' } = req.body || {};
    if (!referenceId || typeof referenceId !== 'string') {
      return res
        .status(400)
        .json({ ok: false, error: 'referenceId is required' });
    }

    const labelUrl =
      process.env.NODE_ENV === 'production'
        ? process.env.DHL_LABEL_URL_PROD
        : process.env.DHL_LABEL_URL;

    if (!labelUrl) {
      return res
        .status(500)
        .json({ ok: false, error: 'DHL_LABEL_URL env not set' });
    }

    // get token
    const tokenResp = await fetch(process.env.DHL_GET_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ApiKey: process.env.DHL_API_KEY,
        ApiSecret: process.env.DHL_API_SECRET,
      },
      body: JSON.stringify({
        customerNumber: process.env.DHL_CUSTOMER_NUMBER,
        password: process.env.DHL_CUSTOMER_PASSWORD,
        identityType: Number(process.env.DHL_IDENTITY_TYPE || 1),
      }),
    });

    if (!tokenResp.ok) {
      const t = await safeJson(tokenResp);
      return res.status(502).json({
        ok: false,
        stage: 'get-token',
        error: `Token request failed ${tokenResp.status}`,
        details: t,
      });
    }
    const tokenJson = await tokenResp.json();
    const accessToken =
      tokenJson?.token ||
      tokenJson?.access_token ||
      tokenJson?.accessToken ||
      tokenJson?.Data?.Token;

    if (!accessToken) {
      return res
        .status(502)
        .json({ ok: false, stage: 'parse-token', error: 'No token in response' });
    }

    // call label API
    const body = {
      customerNumber: process.env.DHL_CUSTOMER_NUMBER,
      referenceId,
      labelType, // 'PDF' or 'ZPL'
      paperSize, // 'A4' or 'A6'
    };

    const labelResp = await fetch(labelUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ApiKey: process.env.DHL_API_KEY,
        ApiSecret: process.env.DHL_API_SECRET,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!labelResp.ok) {
      const j = await safeJson(labelResp);
      return res.status(502).json({
        ok: false,
        stage: 'get-label',
        error: `Label request failed ${labelResp.status}`,
        details: j,
      });
    }

    const contentType = labelResp.headers.get('content-type') || '';
    let base64;
    if (contentType.includes('application/json')) {
      const j = await labelResp.json();
      base64 =
        j?.data || j?.file || j?.Label || j?.label || j?.labelData || j?.Data;
      if (typeof base64 !== 'string') {
        return res.status(502).json({
          ok: false,
          stage: 'parse-label-json',
          error: 'Could not find base64 label in JSON',
          details: j,
        });
      }
    } else {
      const ab = await labelResp.arrayBuffer();
      base64 = Buffer.from(ab).toString('base64');
    }

    const fileName =
      `${referenceId}.${labelType.toUpperCase() === 'ZPL' ? 'zpl' : 'pdf'}`;

    return res.status(200).json({
      ok: true,
      referenceId,
      mimeType:
        labelType.toUpperCase() === 'ZPL'
          ? 'application/zpl'
          : 'application/pdf',
      fileName,
      base64,
    });
  } catch (err) {
    console.error('dhl-label error', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}

async function safeJson(resp) {
  try {
    return await resp.json();
  } catch {
    try {
      return await resp.text();
    } catch {
      return null;
    }
  }
}
