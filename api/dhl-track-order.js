// pages/api/dhl-track-order.js

const BASE = (process.env.DHL_BASE_URL || 'https://testapi.mngkargo.com.tr/mngapi/api').replace(/\/+$/, '');
const KEY  = process.env.DHL_API_KEY || '';
const SEC  = process.env.DHL_API_SECRET || '';

// Optional: public tracking page base (adjust if your team uses a different one)
const PUBLIC_TRACK_BASE = (process.env.DHL_PUBLIC_TRACK_BASE || 'https://selfservis.mngkargo.com.tr/GonderiTakip/?TakipNo=').replace(/\/+$/, '') + (process.env.DHL_PUBLIC_TRACK_BASE ? '' : '');

let cachedToken = null; // { token, exp }

// seconds
const now = () => Math.floor(Date.now() / 1000);

async function getToken() {
  if (cachedToken && cachedToken.exp - 60 > now()) return cachedToken.token;

  const url = `${BASE}/token`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-ibm-client-id': KEY,
      'x-ibm-client-secret': SEC,
      'accept': 'application/json'
    },
    body: '{}'
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Token failed → ${res.status} ${txt}`);
  }

  const json = await res.json();
  const token = json?.accessToken || json?.token || '';
  if (!token) throw new Error('Token missing in response');

  // cache until JWT exp, fallback ~20m
  const parts = token.split('.');
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    cachedToken = { token, exp: Number(payload.exp) || now() + 1200 };
  } catch {
    cachedToken = { token, exp: now() + 1200 };
  }
  return token;
}

async function stdGet(path, token) {
  const url = `${BASE}/standardqueryapi${path}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'authorization': `Bearer ${token}`,
      'x-ibm-client-id': KEY,
      'x-ibm-client-secret': SEC,
      'accept': 'application/json'
    }
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  return { ok: res.ok, status: res.status, data };
}

function pickStatus(payload) {
  const out = {};
  const shipment = payload?.shipment || payload?.Shipment || payload;
  const order    = payload?.order || payload?.Order || payload;

  out.trackingNumber =
    shipment?.shipmentNumber ||
    shipment?.shipmentId ||
    order?.shipmentNumber ||
    order?.shipmentId ||
    payload?.shipmentNumber ||
    payload?.shipmentId;

  out.status =
    payload?.status ||
    payload?.statusName ||
    payload?.currentStatus ||
    shipment?.status ||
    shipment?.statusName ||
    order?.status ||
    order?.statusName;

  out.deliveredAt =
    payload?.deliveredAt ||
    payload?.deliveryDate ||
    shipment?.deliveredAt ||
    shipment?.deliveryDate ||
    order?.deliveredAt ||
    order?.deliveryDate;

  if (out.status) {
    const s = String(out.status).toUpperCase();
    if (s.includes('DELIVER')) out.status = 'DELIVERED';
    else if (s.includes('DAGITIM') || s.includes('OUT FOR')) out.status = 'OUT_FOR_DELIVERY';
    else if (s.includes('TRANSIT')) out.status = 'IN_TRANSIT';
    else if (s.includes('CREATED') || s.includes('ORDER')) out.status = 'CREATED';
  }

  if (out.trackingNumber) {
    out.trackingUrl = PUBLIC_TRACK_BASE
      ? `${PUBLIC_TRACK_BASE}${encodeURIComponent(String(out.trackingNumber))}`
      : null;
  }

  return out;
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

    const ref = (req.query.ref || '').toString().trim();
    const tracking = (req.query.tracking || '').toString().trim();
    if (!ref && !tracking) return res.status(400).json({ ok: false, error: 'Pass ?ref= or ?tracking=' });

    const token = await getToken();

    let best = null;
    const tryPath = async (p) => {
      const r = await stdGet(p, token);
      if (r.ok && r.data) {
        const picked = pickStatus(r.data);
        if (!best || picked.status || picked.trackingNumber || picked.deliveredAt) {
          best = { ...best, ...picked };
        }
      }
      return r;
    };

    // by shipmentId
    if (tracking) {
      await tryPath(`/trackshipmentByShipmentId/${encodeURIComponent(tracking)}`);
      await tryPath(`/getshipmentstatusByShipmentId/${encodeURIComponent(tracking)}`);
      await tryPath(`/getshipmentByShipmentId/${encodeURIComponent(tracking)}`);
    }

    // by reference
    if (ref) {
      const orderR = await tryPath(`/getorder/${encodeURIComponent(ref)}`);
      let discovered;
      if (orderR.ok) {
        const d = (orderR.data?.order || orderR.data || {});
        discovered = d.shipmentId || d.shipmentNumber;
      }
      if (discovered) {
        await tryPath(`/trackshipmentByShipmentId/${encodeURIComponent(discovered)}`);
        await tryPath(`/getshipmentstatusByShipmentId/${encodeURIComponent(discovered)}`);
        await tryPath(`/getshipmentByShipmentId/${encodeURIComponent(discovered)}`);
      } else {
        await tryPath(`/trackshipment/${encodeURIComponent(ref)}`);
        await tryPath(`/getshipmentstatus/${encodeURIComponent(ref)}`);
        await tryPath(`/getshipment/${encodeURIComponent(ref)}`);
      }
    }

    if (best && (best.status || best.trackingNumber || best.deliveredAt)) {
      return res.status(200).json({ ok: true, ...best });
    }

    // sandbox-friendly fallback
    return res.status(200).json({ ok: true, status: 'CREATED' });
  } catch (e) {
    console.error('track-order error', e);
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
