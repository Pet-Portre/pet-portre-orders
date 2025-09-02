// pet-portre-orders/api/health.js
export default async function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: 'pet-portre-orders',
    env: process.env.VERCEL_ENV || 'unknown',
    ts: new Date().toISOString()
  });
}
