// api/dhl-label.js
'use strict';

const OK   = (res, data) => res.status(200).json({ ok: true,  ...data });
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
  return { status: r.status, ok: r.ok, json };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — dhl-label');
    }

    // ✅ Accept either WIX token (what the Sheet sends) OR DHL_API_KEY
    const provided = req.headers['x-api-key'] || '';
    const allow = [process.env.WIX_WEBHOOK_TOKEN, process.env.DHL_API_KEY].filter(Boolean);
    if (!allow.includes(provided)) return FAIL(res, 401, 'Unauthorized');

    const { referenceId, labelType = 'PDF', paperSize = 'A6' } = (req.body || {});
    if (!referenceId) return FAIL(res, 400, 'referenceId required');

    // 1) Get JWT (NO BODY)
    const tok = await jfetch(process.env.DHL_GET_TOKEN_URL, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-ibm-client-id':     process.env.DHL_API_KEY,
        'x-ibm-client-secret': process.env.DHL_API_SECRET,
      }
    });
    if (!tok.ok || !tok.json?.accessToken) return FAIL(res, 502, 'Token failed');
    const jwt = tok.json.accessToken;

    // 2) Ask for label (try explicit then fallbacks)
    const explicit = (process.env.DHL_LABEL_URL || '').replace(/\/+$/, '');
    const baseSQ   = (process.env.DHL_STANDARD_QUERY_URL || '').replace(/\/+$/, '');
    const attempts = [
      { url: explicit,                    body: { barcode: referenceId, labelType, paperSize } },
      { url: `${baseSQ}/getLabel`,        body: { barcode: referenceId, labelType, paperSize } },
      { url: `${baseSQ}/printLabel`,      body: { barcode: referenceId, labelType, paperSize } },
      { url: `${baseSQ}/getLabelByReferenceId`, body: { referenceId, labelType, paperSize } },
    ].filter(a => a.url && a.url.startsWith('http'));

    let got;
    for (const a of attempts) {
      const r = await jfetch(a.url, { headers: { Authorization: `Bearer ${jwt}`, 'Accept':'application/json' }, body: a.body });
      if (r.ok && (r.json?.labelBase64 || r.json?.base64 || r.json?.data)) { got = r.json; break; }
    }
    if (!got) return FAIL(res, 502, 'Label not returned');

    const base64 = got.labelBase64 || got.base64 || got.data?.base64 || got.data || '';
    if (!base64 || typeof base64 !== 'string') return FAIL(res, 502, 'Invalid label payload');

    return OK(res, { base64, fileName: `${referenceId}.pdf` });
  } catch (err) {
    console.error('dhl-label error:', err);
    return FAIL(res, 500, err.message || 'Server error');
  }
};
