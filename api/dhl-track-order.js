// /api/public-track.js  (Vercel serverless function – production)

export default async function handler(req, res) {
  // CORS for Wix
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ ok:false, code:'METHOD_NOT_ALLOWED' });

  try {
    const order = (req.query.order || '').toString().trim();
    const emailRaw = (req.query.email || '').toString().trim();
    if (!order || !emailRaw) {
      return res.status(400).json({ ok:false, code:'BAD_REQUEST' });
    }

    // ---- config (env) ----
    const SELF = process.env.SELF_BASE_URL || 'https://pet-portre-orders.vercel.app';
    const EXPORT_KEY = process.env.EXPORT_KEY; // required for /api/orders-flat
    const DHL_PUBLIC = process.env.DHL_PUBLIC_TRACK_BASE
      || 'https://selfservis.mngkargo.com.tr/GonderiTakip/?TakipNo=';

    // Normalise gmail/googlemail, remove dots and +tags for gmail
    const canonicalEmail = (raw) => {
      let e = String(raw).trim().toLowerCase();
      const at = e.lastIndexOf('@');
      if (at === -1) return e;
      let local = e.slice(0, at);
      let domain = e.slice(at + 1);
      if (domain === 'googlemail.com') domain = 'gmail.com';
      if (domain === 'gmail.com') {
        local = local.split('+')[0].replace(/\./g, '');
      }
      return `${local}@${domain}`;
    };
    const email = canonicalEmail(emailRaw);

    // ---- fetch your exporter (server-side) ----
    const url = `${SELF}/api/orders-flat?key=${encodeURIComponent(EXPORT_KEY)}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`exporter ${r.status}`);
    const payload = await r.json(); // { ok, headers, rows }
    if (!payload || !payload.ok) throw new Error('export payload');

    const headers = payload.headers || [];
    const rows = payload.rows || [];
    const H = Object.fromEntries(headers.map((n, i) => [n, i]));

    const IDX_NO    = H['Sipariş No'];
    const IDX_EMAIL = H['E-posta'];
    const IDX_TRACK = H['Kargo Takip No'];
    const IDX_REF   = H['DHL Referans No'];

    if ([IDX_NO, IDX_EMAIL].some(i => typeof i !== 'number')) {
      return res.status(500).json({ ok:false, code:'MISSING_COLUMNS' });
    }

    // Match by order number (string compare, exact)
    const candidates = rows.filter(r => String(r[IDX_NO] || '').trim() === order);
    if (candidates.length === 0) {
      // Truly not in export → wrong info
      return res.status(404).json({ ok:false, code:'NOT_FOUND' });
    }

    // If multiple rows share the same number, prefer the one whose email matches canonically.
    let row = candidates[0];
    const match = candidates.find(r => canonicalEmail(String(r[IDX_EMAIL] || '')) === email);
    if (match) row = match;

    const rowEmail   = canonicalEmail(String(row[IDX_EMAIL] || ''));
    const tracking   = String(row[IDX_TRACK] || '').trim();
    const reference  = String(row[IDX_REF] || '').trim();

    // If we have a tracking number AND the email matches → ready (send public URL)
    if (tracking && rowEmail === email) {
      return res.status(200).json({
        ok: true,
        stage: 'ready',
        trackingNumber: tracking,
        referenceId: reference || null,
        publicUrl: DHL_PUBLIC + encodeURIComponent(tracking)
      });
    }

    // Known order (so do NOT scare the customer) → processing
    return res.status(200).json({ ok: true, stage: 'processing' });

  } catch (e) {
    return res.status(500).json({ ok:false, code:'SERVER_ERROR', detail:String(e?.message || e) });
  }
}
