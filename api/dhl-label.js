// api/dhl-label.js
// Generate DHL (MNG) label (PDF base64) for a given referenceId

'use strict';

const OK   = (res, data) => res.status(200).json({ ok: true, ...data });
const FAIL = (res, code, msg) => res.status(code).json({ ok: false, error: msg || 'Error' });

async function jfetch(url, opt = {}) {
  const r = await fetch(url, {
    method: opt.method || 'POST',
    headers: { 'content-type': 'application/json', ...(opt.headers || {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
    cache: 'no-store'
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { ok: r.ok, status: r.status, json };
}

async function getJwt() {
  const url = process.env.DHL_GET_TOKEN_URL;                // https://testapi.mngkargo.com.tr/mngapi/api/token
  if (!url) throw new Error('Missing DHL_GET_TOKEN_URL');
  const r = await jfetch(url, {
    // IMPORTANT: token endpoint wants ONLY headers (no body)
    headers: {
      'x-ibm-client-id':     process.env.DHL_API_KEY,
      'x-ibm-client-secret': process.env.DHL_API_SECRET,
      'Accept': 'application/json'
    }
  });
  if (!r.ok || !r.json?.accessToken) {
    throw new Error('Token failed: ' + JSON.stringify(r.json));
  }
  return r.json.accessToken;
}

function pickLabelBase64(payload) {
  return payload?.labelBase64 || payload?.base64 || payload?.data?.base64 || payload?.data || '';
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — dhl-label');
    }

    // Accept either WIX webhook token or export token for this route (not your MNG creds).
    const provided = req.headers['x-api-key'] || '';
    const expectedA = process.env.WIX_WEBHOOK_TOKEN || '';
    const expectedB = process.env.EXPORT_TOKEN || '';
    if (!provided || (provided !== expectedA && provided !== expectedB)) {
      return FAIL(res, 401, 'Unauthorized');
    }

    const { referenceId, labelType = 'PDF', paperSize = 'A6' } = (req.body || {});
    if (!referenceId) return FAIL(res, 400, 'referenceId required');

    const jwt = await getJwt();

    // Build candidate endpoints (prefer explicit env)
    const urls = [];
    if (process.env.DHL_LABEL_URL) {
      urls.push(process.env.DHL_LABEL_URL.replace(/\/+$/, '')); // e.g. .../barcodecmdapi/getLabel
    }
    const baseStd = (process.env.DHL_STANDARD_QUERY_URL || '').replace(/\/+$/, ''); // .../standardqueryapi
    if (baseStd) urls.push(baseStd + '/getLabel');

    // Fallbacks for tenants exposing different shapes
    if (baseStd) urls.push(baseStd + '/printLabel', baseStd + '/getLabelByReferenceId');
    if (urls.length === 0) return FAIL(res, 500, 'No label URL configured');

    let lastErr = null;
    for (const url of urls) {
      // Try by barcode (your createOrder uses barcode=WIXxxxxx)
      let r = await jfetch(url, {
        headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
        body: { barcode: referenceId, labelType, paperSize }
      });
      if (r.ok) {
        const b64 = pickLabelBase64(r.json);
        if (typeof b64 === 'string' && b64.length > 0) {
          const fileName = `${referenceId}.pdf`;
          return OK(res, { base64: b64, fileName });
        }
      }
      // Try by referenceId if API expects that
      r = await jfetch(url, {
        headers: { Authorization: `Bearer ${jwt}`, Accept: 'application/json' },
        body: { referenceId, labelType, paperSize }
      });
      if (r.ok) {
        const b64 = pickLabelBase64(r.json);
        if (typeof b64 === 'string' && b64.length > 0) {
          const fileName = `${referenceId}.pdf`;
          return OK(res, { base64: b64, fileName });
        }
      }
      lastErr = r.json;
    }

    return FAIL(res, 502, 'Label not returned: ' + JSON.stringify(lastErr || {}));
  } catch (err) {
    console.error('dhl-label error:', err);
    return FAIL(res, 500, err.message || 'Server error');
  }
};
