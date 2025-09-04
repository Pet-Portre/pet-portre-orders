// minimal sanity endpoint to prove deployment and routing
module.exports = (req, res) => res.status(200).json({ ok: true, route: 'ping' });
