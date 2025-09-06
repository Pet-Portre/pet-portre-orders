// api/dhl-label.js
// Create MNG/DHL barcode from referenceId, then fetch label (PDF base64)

'use strict';

const OK   = (res, data) => res.status(200).json({ ok: true, ...data });
const FAIL = (res, code, msg) => res.status(code).json({ ok: false, error: msg || 'Error' });

async function jfetch(url, { method = 'POST', headers = {}, body } = {}) {
  const r = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: r.status, ok: r.ok, json };
}

function headerJSON(extra = {}) {
  return { 'Content-Type': 'application/json', ...extra };
}

function pickToken() {
  // accept your sheet’s key (WIX_WEBHOOK_TOKEN) or DHL_API_KEY to avoid 401s
  return process.env.WIX_WEBHOOK_TOKEN || process.env.DHL_API_KEY || '';
}

function barcodeCmdBase() {
  // Prefer explicit base if you add it; else derive from DHL_LABEL_URL
  const explicit = process.env.DHL_BARCODE_CMD_BASE; // e.g. https://testapi.mngkargo.com.tr/mngapi/api/barcodecmdapi
  if (explicit) return explicit.replace(/\/+$/, '');
  const labelUrl = (process.env.DHL_LABEL_URL || '').trim();
  if (!labelUrl) return '';
  // strip trailing /getLabel
  return labelUrl.replace(/\/getLabel\/?$/i, '').replace(/\/+$/, '');
}

function ensureString(v) {
  return (v == null) ? '' : String(v).trim();
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — dhl-label');
    }

    // --- gateway auth (match your Apps Script) ---
    const provided = req.headers['x-api-key'] || '';
    const expected = pickToken();
    if (!expected || provided !== expected) {
      return FAIL(res, 401, 'Unauthorized');
    }

    const {
      referenceId: rawRef,
      labelType = 'PDF',
      paperSize = 'A6'
    } = (req.body || {});
    const referenceId = ensureString(rawRef);
    if (!referenceId) return FAIL(res, 400, 'referenceId required');

    // --- 1) JWT (same pattern as your working Create Order) ---
    const tokenResp = await jfetch(ensureString(process.env.DHL_GET_TOKEN_URL), {
      headers: headerJSON({
        'x-ibm-client-id'    : ensureString(process.env.DHL_API_KEY),
        'x-ibm-client-secret': ensureString(process.env.DHL_API_SECRET),
      }),
      body: {
        customerNumber: ensureString(process.env.DHL_CUSTOMER_NUMBER),
        password      : ensureString(process.env.DHL_CUSTOMER_PASSWORD),
        identityType  : Number(process.env.DHL_IDENTITY_TYPE || 1)
      }
    });

    if (!tokenResp.ok || !tokenResp.json?.accessToken) {
      return FAIL(res, 502, 'Token failed');
    }
    const jwt = tokenResp.json.accessToken;

    // --- 2) Create barcode from referenceId (Barcode Command API) ---
    const bcBase = barcodeCmdBase();
    if (!bcBase) return FAIL(res, 500, 'Missing barcode API base (DHL_LABEL_URL or DHL_BARCODE_CMD_BASE)');

    // First try explicit createbarcode with referenceId
    const createBarcodeUrl = `${bcBase}/createbarcode`;
    let create = await jfetch(createBarcodeUrl, {
      headers: headerJSON({ Authorization: `Bearer ${jwt}` }),
      body: { referenceId }
    });

    // Some tenants may return 409 or an error if barcode already exists; keep going
    let candidateBarcodes = [];

    if (create.ok) {
      // normalize possible shapes
      const j = create.json || {};
      // accepted shapes: { barcode: "..." } or { barcodes: ["..."] } or { data: { barcodes: [...] } }
      if (typeof j.barcode === 'string') candidateBarcodes.push(j.barcode);
      if (Array.isArray(j.barcodes)) candidateBarcodes.push(...j.barcodes);
      if (j.data?.barcode) candidateBarcodes.push(j.data.barcode);
      if (Array.isArray(j.data?.barcodes)) candidateBarcodes.push(...j.data.barcodes);
    }

    // Fallbacks if we didn’t get a barcode (barcode existed already etc.)
    // Try printing by reference, or treating ref as barcode.
    const labelAttempts = [];
    if (candidateBarcodes.length) {
      // real barcode(s)
      for (const bc of candidateBarcodes) {
        labelAttempts.push({ kind: 'barcode', url: `${bcBase}/getLabel`, body: { barcode: bc, labelType, paperSize } });
      }
    } else {
      // fallbacks: some tenants allow printing by referenceId or using ref as "barcode"
      labelAttempts.push({ kind: 'byReference', url: `${bcBase}/getLabelByReferenceId`, body: { referenceId, labelType, paperSize } });
      labelAttempts.push({ kind: 'treatRefAsBarcode', url: `${bcBase}/getLabel`, body: { barcode: referenceId, labelType, paperSize } });
    }

    // --- 3) Get label ---
    let labelResp, got;
    for (const att of labelAttempts) {
      labelResp = await jfetch(att.url, {
        headers: headerJSON({ Authorization: `Bearer ${jwt}` }),
        body: att.body
      });
      if (labelResp.ok && (labelResp.json?.labelBase64 || labelResp.json?.base64 || labelResp.json?.data)) {
        got = labelResp.json;
        break;
      }
    }

    if (!got) {
      // Expose last failure body to help debug in Sheets toast
      return FAIL(res, labelResp?.status || 502, 'Label not returned');
    }

    const base64 = got.labelBase64 || got.base64 || got.data?.base64 || got.data || '';
    if (!base64 || typeof base64 !== 'string') {
      return FAIL(res, 502, 'Invalid label payload');
    }

    return OK(res, { base64, fileName: `${referenceId}.pdf` });
  } catch (err) {
    console.error('dhl-label error:', err);
    return FAIL(res, 500, err.message || 'Server error');
  }
};
