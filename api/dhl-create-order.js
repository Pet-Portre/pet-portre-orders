// api/dhl-create-order.js
'use strict';

// Internal auth: the sheet calls this with header x-api-key = WIX_WEBHOOK_TOKEN

const OK = (res, data) => res.status(200).json({ ok: true, ...data });
const FAIL = (res, code, msg) => res.status(code).json({ ok: false, error: msg || 'Error' });

function str(v) { return v == null ? '' : String(v); }
function num(v, def = 0) { const n = Number(v); return Number.isFinite(n) ? n : def; }
function pick(...xs) { for (const x of xs) if (x !== undefined && x !== null && x !== '') return x; }

async function getDhlToken() {
  const url = process.env.DHL_GET_TOKEN_URL;
  const body = {
    customerNumber: process.env.DHL_CUSTOMER_NUMBER,
    password: process.env.DHL_CUSTOMER_PASSWORD,
    identityType: Number(process.env.DHL_IDENTITY_TYPE || 1)
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ibm-client-id': process.env.DHL_API_KEY,
      'x-ibm-client-secret': process.env.DHL_API_SECRET
    },
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`TOKEN_${resp.status}: ${text}`);

  let tok;
  try {
    const json = JSON.parse(text);
    tok = json?.token || json?.access_token || json?.accessToken || json?.data?.token || json?.data?.accessToken || json?.jwt;
  } catch (_) {
    tok = text;
  }
  if (!tok || typeof tok !== 'string') throw new Error('TOKEN_PARSE_FAILED');
  return tok;
}

function toDhlPayload(input) {
  // Incoming body from Sheet:
  // { referenceId, receiver:{name, phone, email, address, city, district, postcode}, order:{orderNumber, channel, note, sku, description, value} }
  const ref = str(input.referenceId || '');
  const receiver = input.receiver || {};
  const ord = input.order || {};

  // Build content line (keep simple & robust)
  const content = [
    str(ord.description || 'Pet-Portre order').trim(),
    ord.sku ? `(${str(ord.sku)})` : ''
  ].filter(Boolean).join(' ');

  const billId = `INV-${str(ord.orderNumber || ref || '0000')}`;

  // DHL is picky — keep exact keys & types
  return {
    order: {
      referenceId: ref,
      barcode: ref,                          // same as reference
      billOfLandingId: billId,
      isCOD: 0,
      codAmount: 0,
      shipmentServiceType: 1,
      packagingType: 3,
      content,
      paymentType: 1,
      deliveryType: 1,
      description: 'Pet-Portre order',
      marketPlaceShortCode: ''               // leave blank unless DHL instructs (TRND/GG/N11/…)
    },
    orderPieceList: [
      { barcode: `${ref}-1`, desi: 2, kg: 1, content: 'Parcel' }
    ],
    recipient: {
      cityName: str(receiver.city || ''),
      districtName: str(receiver.district || ''),
      address: str(receiver.address || ''),
      email: str(receiver.email || ''),
      fullName: str(receiver.name || ''),
      mobilePhoneNumber: str(receiver.phone || ''),
      postcode: str(receiver.postcode || '')
    }
  };
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return FAIL(res, 405, 'POST only');
    }

    // Internal auth from Sheets
    const key = req.headers['x-api-key'] || '';
    if (!process.env.WIX_WEBHOOK_TOKEN || key !== process.env.WIX_WEBHOOK_TOKEN) {
      return FAIL(res, 401, 'Unauthorized');
    }

    let body;
    try { body = req.body && typeof req.body === 'object' ? req.body : JSON.parse(await new Promise((r) => {
      let data = ''; req.on('data', c => data += c); req.on('end', () => r(data || '{}'));
    })); } catch { body = {}; }

    const referenceId = str(body.referenceId || body.order?.referenceId || '');
    if (!referenceId) return FAIL(res, 400, 'Missing referenceId');

    // Build DHL payload
    const dhlPayload = toDhlPayload(body);

    // Token
    const token = await getDhlToken();

    // Create Order
    const createResp = await fetch(process.env.DHL_CREATE_ORDER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
        'x-ibm-client-id': process.env.DHL_API_KEY,       // required (matches Postman)
        'x-ibm-client-secret': process.env.DHL_API_SECRET // required (matches Postman)
      },
      body: JSON.stringify(dhlPayload)
    });

    const createText = await createResp.text();
    if (!createResp.ok) return FAIL(res, createResp.status, createText || 'Create failed');

    // DHL sometimes returns an array; normalize
    let createJson = null;
    try { createJson = JSON.parse(createText); } catch {}
    const first = Array.isArray(createJson) ? createJson[0] : (createJson || {});

    // Shape a friendly response for the Sheet (it expects ok + some optional fields)
    return OK(res, {
      carrier: 'DHL (MNG)',
      trackingNumber: '', // not provided on create; will be fetched via tracking endpoint later
      dhl: {
        orderInvoiceId: str(first.orderInvoiceId || ''),
        orderInvoiceDetailId: str(first.orderInvoiceDetailId || ''),
        shipperBranchCode: str(first.shipperBranchCode || ''),
        referenceId: referenceId
      },
      raw: createJson ?? createText
    });
  } catch (err) {
    return FAIL(res, 500, err.message || 'Server error');
  }
};
