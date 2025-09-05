// api/db-ping.js
const { withDb } = require('../lib/db');

module.exports = async (_req, res) => {
  try {
    const ping = await withDb(db => db.admin().ping());
    res.json({
      ok: true,
      db: process.env.MONGODB_DB || 'Pet-Portre-Orders',
      ping,
      time: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
      stack: String(err.stack || ''),
      env: {
        hasURI: !!process.env.MONGODB_URI,
        db: process.env.MONGODB_DB,
        node: process.version,
      },
    });
  }
};
