// api/dhl-label.js
// Generate/download DHL (MNG) shipping label and return base64 to Sheets

'use strict';

const OK = (res, data) => res.status(200).json({ ok: true, ...data });
const FAIL = (res, code, msg) => res.status(code).json({ ok: false, error: msg || 'Error' });

// tiny helper
async function jfetch(url, opt = {}) {
  const r = await fetch(url, {
    method: opt.method || 'POST',
    headers: { 'content-type': 'application/json', ...(opt.headers || {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
    cache: 'no-store',
  });
  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: r.status, ok: r.ok, json };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — dhl-label');
    }

    // simple api-key gate (same style as your other routes)
    const provided = req.headers['x-api-key'] || '';
    const expected = process.env.DHL_API_KEY || process.env.WIX_WEBHOOK_TOKEN || '';
    if (!expected || provided !== expected) {
      return FAIL(res, 401, 'Unauthorized');
    }

    const {
      referenceId,
      labelType = 'PDF',   // your Sheet sends 'PDF'
      paperSize = 'A6',    // your Sheet sends 'A6'
    } = (req.body || {});
    if (!referenceId) return FAIL(res, 400, 'referenceId required');

    // Map to MNG enum codes
    const lt = String(labelType).toUpperCase();
    const ps = String(paperSize).toUpperCase();
    const labelTypeCode = (lt === 'ZPL') ? 2 : 1; // PDF=1, ZPL=2
    const paperSizeCode =
      ps === 'A4' ? 1 :
      ps === 'A5' ? 2 :
      ps === 'A6' ? 4 :
      (/^\d+$/.test(ps) ? Number(ps) : 4); // default A6

    // 1) Get JWT from MNG
    const tokenResp = await jfetch(process.env.DHL_GET_TOKEN_URL, {
      headers: {
        'x-ibm-client-id': process.env.DHL_API_KEY,
        'x-ibm-client-secret': process.env.DHL_API_SECRET,
      },
      body: {
        customerNumber: process.env.DHL_CUSTOMER_NUMBER,
        password: process.env.DHL_CUSTOMER_PASSWORD,
        identityType: Number(process.env.DHL_IDENTITY_TYPE || 1),
      },
    });
    if (!tokenResp.ok || !tokenResp.json?.accessToken) {
      return FAIL(res, 502, 'Token failed');
    }
    const jwt = tokenResp.json.accessToken;

    // 2) Call label endpoint (use your configured label URL)
    const labelUrl = (process.env.DHL_LABEL_URL || '').replace(/\/+$/, '');
    if (!labelUrl) return FAIL(res, 500, 'DHL_LABEL_URL missing');

    const labelResp = await jfetch(labelUrl, {
      headers: { Authorization: `Bearer ${jwt}` },
      body: {
        barcode: referenceId,
        labelType: labelTypeCode,
        paperSize: paperSizeCode
      },
    });

    if (!labelResp.ok) {
      const msg = labelResp.json?.message || labelResp.json?.error || 'Label fetch failed';
      return FAIL(res, labelResp.status, msg);
    }

    const base64 =
      labelResp.json?.labelBase64 ||
      labelResp.json?.base64 ||
      labelResp.json?.data ||
      labelResp.json?.pdfBase64 ||
      '';

    if (!base64 || typeof base64 !== 'string') {
      return FAIL(res, 502, 'Invalid label payload');
    }

    return OK(res, { base64, fileName: `${referenceId}.pdf` });
  } catch (err) {
    console.error('dhl-label error:', err);
    return FAIL(res, 500, err.message || 'Server error');
  }
};
