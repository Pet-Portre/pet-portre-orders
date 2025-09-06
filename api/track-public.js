// pages/api/track-public.js  (PRODUCTION)
import { MongoClient } from 'mongodb';

let _client;
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

function buildPublicUrl(doc) {
  const tn = doc?.dhl?.trackingNumber || doc?.trackingNumber;
  const direct = doc?.dhl?.publicUrl || doc?.publicUrl;
  if (direct && /^https?:\/\//i.test(direct)) return direct;
  if (tn) {
    const base = process.env.DHL_PUBLIC_TRACK_BASE || 'https://selfservis.mngkargo.com.tr/GonderiTakip/?TakipNo=';
    return base + encodeURIComponent(String(tn));
  }
  return '';
}

function sanitizeEmail(s='')   { return String(s).trim().toLowerCase(); }
function sanitizeOrderNo(s='') { return String(s).trim(); }

export default async function handler(req, res) {
  // CORS: allow your Wix site; keep * if you prefer simplicity
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') return bad(res, { state: 'bad_request', error: 'GET only' });

  const email   = sanitizeEmail(req.query.email);
  const orderNo = sanitizeOrderNo(req.query.orderNo);

  if (!email || !orderNo) return bad(res, { state: 'bad_request' });

  try {
    const db  = await getDb();
    const col = db.collection('orders');

    // exact order number + case-insensitive email
    const doc = await col.findOne({
      orderNumber: orderNo,
      $or: [
        { email: { $regex: new RegExp(`^${escapeRegex(email)}$`, 'i') } },
        { customerEmail: { $regex: new RegExp(`^${escapeRegex(email)}$`, 'i') } }
      ]
    });

    if (!doc) return nf(res);

    const hasLive =
      !!(doc?.dhl?.publicUrl || doc?.publicUrl || doc?.dhl?.trackingNumber || doc?.trackingNumber);

    if (hasLive) {
      const url = buildPublicUrl(doc);
      if (url) return ok(res, { state: 'live', url });
    }

    return ok(res, { state: 'pending' });
  } catch (e) {
    return bad(res, { state: 'bad_request', error: e?.message || 'ERR' });
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}// pages/api/track-public.js  (PRODUCTION)
import { MongoClient } from 'mongodb';

let _client;
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

function buildPublicUrl(doc) {
  const tn = doc?.dhl?.trackingNumber || doc?.trackingNumber;
  const direct = doc?.dhl?.publicUrl || doc?.publicUrl;
  if (direct && /^https?:\/\//i.test(direct)) return direct;
  if (tn) {
    const base = process.env.DHL_PUBLIC_TRACK_BASE || 'https://selfservis.mngkargo.com.tr/GonderiTakip/?TakipNo=';
    return base + encodeURIComponent(String(tn));
  }
  return '';
}

function sanitizeEmail(s='')   { return String(s).trim().toLowerCase(); }
function sanitizeOrderNo(s='') { return String(s).trim(); }

export default async function handler(req, res) {
  // CORS: allow your Wix site; keep * if you prefer simplicity
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') return bad(res, { state: 'bad_request', error: 'GET only' });

  const email   = sanitizeEmail(req.query.email);
  const orderNo = sanitizeOrderNo(req.query.orderNo);

  if (!email || !orderNo) return bad(res, { state: 'bad_request' });

  try {
    const db  = await getDb();
    const col = db.collection('orders');

    // exact order number + case-insensitive email
    const doc = await col.findOne({
      orderNumber: orderNo,
      $or: [
        { email: { $regex: new RegExp(`^${escapeRegex(email)}$`, 'i') } },
        { customerEmail: { $regex: new RegExp(`^${escapeRegex(email)}$`, 'i') } }
      ]
    });

    if (!doc) return nf(res);

    const hasLive =
      !!(doc?.dhl?.publicUrl || doc?.publicUrl || doc?.dhl?.trackingNumber || doc?.trackingNumber);

    if (hasLive) {
      const url = buildPublicUrl(doc);
      if (url) return ok(res, { state: 'live', url });
    }

    return ok(res, { state: 'pending' });
  } catch (e) {
    return bad(res, { state: 'bad_request', error: e?.message || 'ERR' });
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
