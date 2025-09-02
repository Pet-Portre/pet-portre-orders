// DHL eCommerce TR (MNG Kargo) — Standard Query tracking
// Supports query params:
//   ?trackingNo=...   OR  ?tracking=...   OR  ?barcode=...   (barcode/tracking number)
//   ?ref=...          OR  ?referenceId=...                  (your shipment reference)

const fetch = require('node-fetch');

const CFG = {
  tokenUrl: process.env.DHL_GET_TOKEN_URL,
  standardBase: process.env.DHL_STANDARD_QUERY_URL, // e.g. https://testapi.mngkargo.com.tr/mngapi/api/standardqueryapi
  apiKey: process.env.DHL_API_KEY,                  // x-ibm-client-id
  apiSecret: process.env.DHL_API_SECRET,            // x-ibm-client-secret
  customerNumber: process.env.DHL_CUSTOMER_NUMBER,
  customerPassword: process.env.DHL_CUSTOMER_PASSWORD,
  identityType: Number(process.env.DHL_IDENTITY_TYPE || 1) // 1 = customer credentials
};

function pick(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  return undefined;
}

async function getToken() {
  const body = {
    customerNumber: CFG.customerNumber,
    password: CFG.customerPassword,
    identityType: CFG.identityType
  };

  const res = await fetch(CFG.tokenUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ibm-client-id': CFG.apiKey,
      'x-ibm-client-secret': CFG.apiSecret
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = {}; }

  if (!res.ok) {
    throw new Error(`Token error ${res.status}: ${text}`);
  }
  const jwt = json.jwt || json.token || json.access_token;
  if (!jwt) throw new Error('Token missing in response');
  return jwt;
}

async function queryShipment(jwt, query) {
  const trackingNo = pick(query.trackingNo, query.tracking, query.barcode, query.waybill);
  const referenceId = pick(query.ref, query.referenceId);

  if (!trackingNo && !referenceId) {
    const err = 'Provide ?trackingNo=... (or ?tracking=... / ?barcode=...) or ?ref=...';
    return { ok: false, error: 'BAD_REQUEST', message: err, status: 400 };
  }

  const headers = {
    'content-type': 'application/json',
    'accept': 'application/json',
    'authorization': `Bearer ${jwt}`,
    'x-ibm-client-id': CFG.apiKey,
    'x-ibm-client-secret': CFG.apiSecret
  };

  // MNG’s Standard Query endpoint path often ends with /getshipment or /getShipment
  const candidates = [
    `${CFG.standardBase.replace(/\/$/, '')}/getshipment`,
    `${CFG.standardBase.replace(/\/$/, '')}/getShipment`
  ];

  const body = JSON.stringify({
    // The API is flexible — include whichever you have
    barcode: trackingNo || undefined,
    referenceId: referenceId || undefined
  });

  let lastText = '';
  for (const url of candidates) {
    const r = await fetch(url, { method: 'POST', headers, body });
    lastText = await r.text();
    let j; try { j = JSON.parse(lastText); } catch { j = {}; }

    if (r.ok) {
      return normalizeResponse(trackingNo, referenceId, j);
    }
    // If 404 on first path, try the alternative casing
    if (r.status === 404) continue;

    return { ok: false, error: 'STANDARD_QUERY_ERROR', status: r.status, raw: j || lastText };
  }
  return { ok: false, error: 'ENDPOINT_NOT_FOUND', raw: lastText };
}

function normalizeResponse(trackingNo, referenceId, j) {
  // Try to normalize a few likely shapes without guessing too much
  const summary = j.summary || j.result || j.data || j;
  const status =
    summary.status ||
    summary.shipmentStatus ||
    (Array.isArray(summary.events) && summary.events[0] ? summary.events[0].status : undefined) ||
    summary.message ||
    'Unknown';

  // Build events array if present
  const rawEvents = summary.events || summary.shipmentEvents || summary.history || [];
  const events = Array.isArray(rawEvents) ? rawEvents.map(e => ({
    time: e.time || e.date || e.eventTime || e.createDate || null,
    location: e.location || e.branch || e.city || null,
    description: e.description || e.status || e.event || null
  })) : [];

  // Delivery date if present
  const deliveredAt =
    summary.deliveredAt ||
    summary.deliveryDate ||
    (events.find(e => /delivered|teslim/i.test(e.description || '')) || {}).time ||
    null;

  return {
    ok: true,
    carrier: 'MNG Kargo',
    trackingNumber: trackingNo || null,
    referenceId: referenceId || null,
    status,
    deliveredAt,
    events,
    raw: j // keep raw for debugging if needed by Sheets
  };
}

module.exports = async (req, res) => {
  try {
    const jwt = await getToken();
    const out = await queryShipment(jwt, Object.fromEntries(new URL(req.url, 'http://localhost').searchParams));

    const code = out.ok ? 200 : (out.status || 400);
    res.setHeader('content-type', 'application/json');
    res.status(code).end(JSON.stringify(out));
  } catch (err) {
    console.error('dhl-track-order error:', err);
    res.status(200).json({ ok: false, error: String(err && err.message || err) });
  }
};
