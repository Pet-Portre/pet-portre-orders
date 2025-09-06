// api/dhl-label.js
// Generate/download DHL (MNG) label and return base64 to Sheets

'use strict';

const OK   = (res, data) => res.status(200).json({ ok: true,  ...data });
const FAIL = (res, code, msg) => res.status(code).json({ ok: false, error: msg || 'Error' });

// small fetch helper (no caching)
async function jfetch(url, opt = {}) {
  const r = await fetch(url, {
    method: opt.method || 'POST',
    headers: { 'content-type': 'application/json', ...(opt.headers || {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
    cache: 'no-store'
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

    // simple api-key gate (same style as other routes)
    const provided = req.headers['x-api-key'] || '';
    const expected = process.env.DHL_API_KEY || process.env.WIX_WEBHOOK_TOKEN || '';
    if (!expected || provided !== expected) {
      return FAIL(res, 401, 'Unauthorized');
    }

    const {
      referenceId,
      labelType = 'PDF',
      paperSize = 'A6',
    } = (req.body || {});

    if (!referenceId) return FAIL(res, 400, 'referenceId required');

    // --- 1) Get JWT from MNG (NO BODY — headers only) ---
    const tokenResp = await jfetch(process.env.DHL_GET_TOKEN_URL, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-ibm-client-id':     process.env.DHL_API_KEY,
        'x-ibm-client-secret': process.env.DHL_API_SECRET,
      }
      // body: undefined  // <- IMPORTANT: do not send any body, avoids 415 & "Token failed"
    });
    if (!tokenResp.ok || !tokenResp.json?.accessToken) {
      return FAIL(res, 502, 'Token failed');
    }
    const jwt = tokenResp.json.accessToken;

    // --- 2) Request label ---
    // Prefer explicit env URL first (your .env: DHL_LABEL_URL = .../barcodecmdapi/getLabel)
    const explicit = (process.env.DHL_LABEL_URL || '').replace(/\/+$/, '');
    const baseSQ   = (process.env.DHL_STANDARD_QUERY_URL || '').replace(/\/+$/, '');

    // Try a few compatible endpoints/payloads (providers vary slightly)
    const attempts = [
      // explicit barcode command API
      { url: `${explicit}`,                            body: { barcode: referenceId, labelType, paperSize } },
      // standard query API variants
      { url: `${baseSQ}/getLabel`,                     body: { barcode: referenceId, labelType, paperSize } },
      { url: `${baseSQ}/printLabel`,                   body: { barcode: referenceId, labelType, paperSize } },
      { url: `${baseSQ}/getLabelByReferenceId`,        body: { referenceId,      labelType, paperSize } },
    ].filter(a => a.url && a.url.startsWith('http'));

    let got;
    for (const a of attempts) {
      const r = await jfetch(a.url, {
        headers: { Authorization: `Bearer ${jwt}`, 'Accept': 'application/json' },
        body: a.body
      });
      // success shapes observed in different tenants
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

    return OK(res, { base64, fileName: `${referenceId}.pdf` });
  } catch (err) {
    console.error('dhl-label error:', err);
    return FAIL(res, 500, err.message || 'Server error');
  }
};
