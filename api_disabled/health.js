export default async function handler(_req, res) {
  res.status(200).json({ ok: true, service: "pet-portre-orders", time: new Date().toISOString() });
}
