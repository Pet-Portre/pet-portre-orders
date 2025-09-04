// api/db-ping.js
module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  try {
    const { getDb } = require('../lib/db');
    const db = await getDb();
    const ping = await db.command({ ping: 1 });
    res.status(200).end(JSON.stringify({
      ok: true,
      db: process.env.MONGODB_DB,
      ping,
    }));
  } catch (e) {
    // Make the error visible in the response instead of a 500
    console.error('db-ping error:', e);
    res.status(200).end(JSON.stringify({
      ok: false,
      error: e.message,
      stack: String(e.stack).split('\n').slice(0, 6),
      env: {
        hasURI: !!process.env.MONGODB_URI,
        db: process.env.MONGODB_DB,
        node: process.version,
      },
    }));
  }
};
