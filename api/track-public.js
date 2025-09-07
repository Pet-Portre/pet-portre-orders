// pages/api/track-public.js  — PRODUCTION
// Returns one of: { ok:true, state:'live', url }, { ok:true, state:'pending' }, { ok:true, state:'not_found' }
// 400 -> { ok:false, state:'bad_request', error }

import { MongoClient } from 'mongodb';

let _client;
/** Reuse a single Mongo client across invocations */
async function getDb() {
  if (!_client) {
    _client = new MongoClient(process.env.MONGODB_URI, { connectTimeoutMS: 10000 });
    await _client.connect();
  }
  return _client.db(process.env.MONGODB_DB);
}

function ok(res, body)  { return res.status(200).json({ ok: true, ...body }); }
function bad(res, body) { return res.status(400).json({ ok: false, ...body }); }
function nf(res)        { return res.status(200).json({ ok: true, state: 'not_found' }); }

function sanitizeEmail(s = '')   { return String(s).trim().toLowerCase(); }
function sanitizeOrderNo(s = '') { return String(s).trim(); }
function escapeRegex(s)          { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Build a public tracking URL (MNG/DHL) from doc fields or env fallback */
function buildPublicUrl(doc) {
  const tn     = doc?.dhl?.trackingNumber || doc?.trackingNumber;
  const direct = doc?.dhl?.publicUrl     || doc?.publicUrl;
  if (direct && /^https?:\/\//i.test(direct)) return direct;
  if (tn) {
    const base = process.env.DHL_PUBLIC_TRACK_BASE
      || 'https://selfservis.mngkargo.com.tr/GonderiTakip/?TakipNo=';
    return base + encodeURIComponent(String(tn));
  }
  return '';
}

export default async function handler(req, res) {
  // CORS: allow calling from Wix
  res.setHeader('Access-Control-Allow-Origin', '*'); // lock to your domain later if you prefer
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') {
    return bad(res, { state: 'bad_request', error: 'GET only' });
  }

  const email   = sanitizeEmail(req.query.email);
  const orderNo = sanitizeOrderNo(req.query.orderNo);

  if (!email || !orderNo) return bad(res, { state: 'bad_request', error: 'missing params' });

  try {
    const db  = await getDb();
    const col = db.collection('orders');

    // Match exact order number and case-insensitive email in any of these fields
    const emailRx = new RegExp(`^${escapeRegex(email)}$`, 'i');
    const doc = await col.findOne({
      orderNumber: orderNo,
      $or: [
        { email: emailRx },
        { customerEmail: emailRx },
        { 'buyer.email': emailRx }
      ]
    });

    if (!doc) return nf(res);

    const hasAnyLive =
      !!(doc?.dhl?.publicUrl || doc?.publicUrl || doc?.dhl?.trackingNumber || doc?.trackingNumber);

    if (hasAnyLive) {
      const url = buildPublicUrl(doc);
      if (url) return ok(res, { state: 'live', url });
    }

    // Order exists but no tracking yet
    return ok(res, { state: 'pending' });
  } catch (e) {
    return bad(res, { state: 'bad_request', error: e?.message || 'ERR' });
  }
}
