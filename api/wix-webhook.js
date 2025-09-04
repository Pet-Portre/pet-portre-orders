// File: api/wix-webhook.js
module.exports = (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('POST only – wix-webhook alive');
  }
  return res.status(200).json({ ok: true, ping: 'wix-webhook alive', at: new Date().toISOString() });
};
