// api/health.js
// Minimal health probe
module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'pet-portre-orders',
    time: new Date().toISOString(),
  });
};
