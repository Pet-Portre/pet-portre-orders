// api/wix-webhook.js
// Minimal webhook to prove routing works (no DB yet)
// Requires Vercel env var: WIX_WEBHOOK_TOKEN
module.exports = (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('POST only');
  }

  const expected = process.env.WIX_WEBHOOK_TOKEN || '';
  const got = (req.query && req.query.token) ? String(req.query.token) : '';

  if (!expected || got !== expected) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const size = req.body ? JSON.stringify(req.body).length : 0;
  console.log('Wix hit @', new Date().toISOString(), 'bytes:', size);

  return res.status(200).json({ ok: true, receivedAt: new Date().toISOString() });
};
