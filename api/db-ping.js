// api/db-ping.js
const { getDb } = require('../lib/db');

module.exports = async (req, res) => {
  try {
    const db = await getDb();
    const r = await db.command({ ping: 1 });
    res.json({ ok: true, db: process.env.MONGODB_DB || 'Pet-Portre-Orders', ping: r?.ok === 1 });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
      name: e.name,
      code: e.code
    });
  }
};
