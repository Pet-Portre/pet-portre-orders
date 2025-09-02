module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    service: 'pet-portre-orders',
    env: process.env.VERCEL_ENV || 'production',
    time: new Date().toISOString()
  });
};
