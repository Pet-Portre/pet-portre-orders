// api/db-ping.js
const { withDb } = require('../lib/db');

module.exports = async (req, res) => {
  // keep this simple and cacheless so it reflects live connectivity
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'GET only — db-ping' });
  }

  try {
    const { ping, dbName } = await withDb(async (db) => {
      const ping = await db.admin().ping();        // { ok: 1 }
      return { ping, dbName: db.databaseName };
    });

    return res.status(200).json({
      ok: true,
      db: dbName,
      ping,
      time: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
      stack: String(err.stack || '').split('\n').slice(0, 3).join('\n'),
      env: {
        hasURI: !!process.env.MONGODB_URI,
        db: process.env.MONGODB_DB,
        node: process.version,
      },
    });
  }
};
