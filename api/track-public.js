// /pages/api/orders-track-public.js
// Resolves an order to: { ok:true, state:'live', url } | { ok:true, state:'pending' } | { ok:true, state:'not_found' }

import { MongoClient } from 'mongodb';

let _client;
async function getDb() {
  if (!_client) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI missing');
    _client = new MongoClient(uri, { connectTimeoutMS: 10000 });
    await _client.connect();
  }
  // If MONGODB_DB is unset, driver uses DB from connection string
  return _client.db(process.env.MONGODB_DB);
}

function ok(res, body)  { return res.status(200).json({ ok: true, ...body }); }
function bad(res, body) { return res.status(400).json({ ok: false, ...body }); }
function nf(res)        { return res.status(200).json({ ok: true, state: 'not_found' }); }
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function sanitizeEmail(s='')   { return String(s).trim().toLowerCase(); }
function sanitizeOrderNo(s='') { return String(s).trim(); }

// Build a public tracking URL for MNG/DHL if we have only the tracking number
function buildPublicUrlFromDoc(doc) {
  const tn = doc?.dhl?.trackingNumber || doc?.trackingNumber || '';
  const direct = doc?.dhl?.publicUrl || doc?.publicUrl || '';
  if (direct && /^https?:\/\//i.test(direct)) return direct;
  if (tn) {
    const base = process.env.DHL_PUBLIC_TRACK_BASE
      || 'https://selfservis.mngkargo.com.tr/GonderiTakip/?TakipNo=';
    return base + encodeURIComponent(String(tn));
  }
  return '';
}

export default async function handler(req, res) {
  // CORS (allow Wix site)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return bad(res, { state: 'bad_request', error: 'GET only' });

  const email   = sanitizeEmail(req.query.email);
  const orderNo = sanitizeOrderNo(req.query.orderNo);
  if (!email || !orderNo) return bad(res, { state: 'bad_request', error: 'email/orderNo missing' });

  try {
    // 1) Try Mongo first
    let doc = null;
    try {
      const db  = await getDb();
      const col = db.collection('orders');
      doc = await col.findOne({
        orderNumber: orderNo,
        $or: [
          { email:         { $regex: new RegExp(`^${escapeRegex(email)}$`, 'i') } },
          { customerEmail: { $regex: new RegExp(`^${escapeRegex(email)}$`, 'i') } }
        ]
      });
    } catch (e) {
      // Mongo optional; continue to exporter fallback
    }

    if (doc) {
      const hasLive = !!(doc?.dhl?.publicUrl || doc?.publicUrl || doc?.dhl?.trackingNumber || doc?.trackingNumber);
      if (hasLive) {
        const url = buildPublicUrlFromDoc(doc);
        if (url) return ok(res, { state: 'live', url });
      }
      return ok(res, { state: 'pending' });
    }

    // 2) Fallback to the orders exporter (/api/orders-flat) using EXPORT_TOKEN
    const SELF_BASE = process.env.SELF_BASE_URL || `https://${req.headers.host}`;
    const EXPORT_TOKEN = process.env.EXPORT_TOKEN; // <- your single source of truth
    if (!EXPORT_TOKEN) return nf(res);

    const flatUrl = `${SELF_BASE}/api/orders-flat?key=${encodeURIComponent(EXPORT_TOKEN)}`;
    const resp = await fetch(flatUrl, { headers: { accept: 'application/json' } });
    if (!resp.ok) return nf(res);

    const data = await resp.json(); // expected: { ok, headers, rows }
    const headers = Array.isArray(data?.headers) ? data.headers : [];
    const rows    = Array.isArray(data?.rows)    ? data.rows    : [];

    // locate column indexes by header name
    const idxNo    = findHeader(headers, ['Sipariş No','Siparis No','Order No','orderNumber']);
    const idxEmail = findHeader(headers, ['E-posta','Eposta','Email','email']);
    const idxTrack = findHeader(headers, ['Kargo Takip No','Tracking','trackingNumber']);
    if (idxNo < 0 || idxEmail < 0) return nf(res);

    // find matching row by order no + email (case-insensitive for email)
    const row = rows.find(r =>
      (String(r[idxNo] || '').trim() === orderNo) &&
      (String(r[idxEmail] || '').trim().toLowerCase() === email)
    );
    if (!row) return nf(res);

    const rawTracking = idxTrack >= 0 ? String(row[idxTrack] || '').trim() : '';
    if (rawTracking) {
      const base = process.env.DHL_PUBLIC_TRACK_BASE
        || 'https://selfservis.mngkargo.com.tr/GonderiTakip/?TakipNo=';
      return ok(res, { state: 'live', url: base + encodeURIComponent(rawTracking) });
    }
    return ok(res, { state: 'pending' });
  } catch (e) {
    return bad(res, { state: 'bad_request', error: e?.message || 'ERR' });
  }
}

// best-effort header matcher (handles Turkish/English variants)
function findHeader(headers, candidates) {
  const canon = headers.map(h => String(h || '').trim().toLowerCase());
  for (const cand of candidates) {
    const i = canon.indexOf(String(cand).trim().toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}
