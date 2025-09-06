'use strict';

const OK   = (res, data) => res.status(200).json({ ok: true, ...data });
const FAIL = (res, code, msg) => res.status(code).json({ ok: false, error: msg || 'Error' });

async function jfetch(url, opt = {}) {
  const r = await fetch(url, {
    method: opt.method || 'POST',
    headers: { ...(opt.headers || {}) },
    body: opt.body ? JSON.stringify(opt.body) : undefined,
    cache: 'no-store',
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: r.status, ok: r.ok, json };
}

function pickJwt(j) {
  return j?.accessToken || j?.access_token || j?.token || j?.data?.accessToken || null;
}

async function getJwt() {
  const url = process.env.DHL_GET_TOKEN_URL;
  const headers = {
    'Accept': 'application/json',
    'x-ibm-client-id':     process.env.DHL_API_KEY,
    'x-ibm-client-secret': process.env.DHL_API_SECRET,
  };

  // 1) POST (no body)
  let r = await jfetch(url, { headers });
  let jwt = pickJwt(r.json);
  if (r.ok && jwt) return { jwt };

  // 2) GET
  try {
    const r2 = await fetch(url, { method: 'GET', headers, cache: 'no-store' });
    const t2 = await r2.text(); let j2; try { j2 = t2 ? JSON.parse(t2) : {}; } catch { j2 = { raw: t2 }; }
    const jwt2 = pickJwt(j2);
    if (r2.ok && jwt2) return { jwt: jwt2 };
  } catch {}

  // 3) POST with {}
  const r3 = await jfetch(url, { headers: { ...headers, 'Content-Type': 'application/json' }, body: {} });
  const jwt3 = pickJwt(r3.json);
  if (r3.ok && jwt3) return { jwt: jwt3 };

  return { error: { step1: r, step3: r3 } };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — dhl-label');
    }

    // fire-door auth (any of these is OK)
    const provided = req.headers['x-api-key'] || '';
    const allow = [
      process.env.WIX_WEBHOOK_TOKEN,
      process.env.EXPORT_TOKEN,
      process.env.DHL_API_KEY,
    ].filter(Boolean);
    if (!allow.includes(provided)) return FAIL(res, 401, 'Unauthorized');

    const { referenceId, labelType = 'PDF', paperSize = 'A6' } = (req.body || {});
    if (!referenceId) return FAIL(res, 400, 'referenceId required');

    // --- token
    const t = await getJwt();
    if (!t.jwt) return FAIL(res, 502, `Token failed: ${JSON.stringify(t.error || {})}`);
    const jwt = t.jwt;

    // --- label attempts
    const explicit = (process.env.DHL_LABEL_URL || '').trim(); // /barcodecmdapi/getLabel
    const stdBase  = (process.env.DHL_STANDARD_QUERY_URL || '').replace(/\/+$/, '');

    const attempts = [];
    if (explicit) attempts.push({ url: explicit, body: { barcode: referenceId, labelType, paperSize } });
    if (stdBase) {
      attempts.push(
        { url: `${stdBase}/getLabel`,              body: { barcode: referenceId, labelType, paperSize } },
        { url: `${stdBase}/printLabel`,            body: { barcode: referenceId, labelType, paperSize } },
        { url: `${stdBase}/getLabelByReferenceId`, body: { referenceId,       labelType, paperSize } },
      );
    }

    let got;
    for (const a of attempts) {
      const r = await jfetch(a.url, {
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: a.body,
      });
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
