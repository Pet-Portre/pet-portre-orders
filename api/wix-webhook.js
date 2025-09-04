// api/wix-webhook.js  (PING ONLY — no DB import yet)
module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — wix-webhook');
    }

    const token = (req.query.token || '').trim();
    if (!process.env.WIX_WEBHOOK_TOKEN || token !== process.env.WIX_WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // Just echo basic info so we know the handler ran
    let raw = '';
    if (req.body && typeof req.body === 'object') raw = JSON.stringify(req.body);
    else if (typeof req.body === 'string') raw = req.body;

    return res.status(200).json({
      ok: true,
      ping: true,
      len: raw.length,
      at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('wix-webhook ping fail:', e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
};
