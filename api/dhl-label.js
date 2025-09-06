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
    cache: 'no-store', // avoid CDN caching on Vercel
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

    // --- accept either WIX_WEBHOOK_TOKEN or DHL_API_KEY (IBM client id) ---
    const provided = req.headers['x-api-key'] || '';
    const allowedKeys = [
      process.env.WIX_WEBHOOK_TOKEN,
      process.env.EXPORT_TOKEN,          // optional: your internal export key
      process.env.DHL_API_KEY            // IBM client id
    ].filter(Boolean);
    if (!allowedKeys.includes(provided)) {
      return FAIL(res, 401, 'Unauthorized');
    }

    const {
      referenceId,
      labelType = 'PDF',   // PDF or ZPL
      paperSize = 'A6',    // A6 as used by your sheet
    } = (req.body || {});

    if (!referenceId) return FAIL(res, 400, 'referenceId required');

    // 1) Get JWT from MNG
    const tokenResp = await jfetch(process.env.DHL_GET_TOKEN_URL, {
      headers: {
        'x-ibm-client-id':     process.env.DHL_API_KEY,
        'x-ibm-client-secret': process.env.DHL_API_SECRET,
      },
      body: {
        customerNumber: process.env.DHL_CUSTOMER_NUMBER,
        password:       process.env.DHL_CUSTOMER_PASSWORD,
        identityType:   Number(process.env.DHL_IDENTITY_TYPE || 1),
      },
    });
    if (!tokenResp.ok || !tokenResp.json?.accessToken) {
      return FAIL(res, 502, 'Token failed');
    }
    const jwt = tokenResp.json.accessToken;

    // 2) Ask label from Standard Query API
    const base = (process.env.DHL_STANDARD_QUERY_URL || '').replace(/\/+$/, '');
    const attempts = [
      { url: `${base}/getLabel`,                 body: { barcode: referenceId, labelType, paperSize } },
      { url: `${base}/printLabel`,               body: { barcode: referenceId, labelType, paperSize } },
      { url: `${base}/getLabelByReferenceId`,    body: { referenceId, labelType, paperSize } },
    ];

    let got;
    for (const a of attempts) {
      const r = await jfetch(a.url, {
        headers: { Authorization: `Bearer ${jwt}` },
        body: a.body,
      });
      if (r.ok && (r.json?.labelBase64 || r.json?.base64 || r.json?.data)) {
        got = r.json;
        break;
      }
    }

    if (!got) return FAIL(res, 502, 'Label not returned');

    const base64 =
      got.labelBase64 || got.base64 || got.data?.base64 || got.data || '';

    if (!base64 || typeof base64 !== 'string') {
      return FAIL(res, 502, 'Invalid label payload');
    }

    const fileName = `${referenceId}.pdf`;
    return OK(res, { base64, fileName });
  } catch (err) {
    console.error('dhl-label error:', err);
    return FAIL(res, 500, err.message || 'Server error');
  }
};
