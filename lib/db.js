// api/db-ping.js
const { getDB } = require('../lib/db');

module.exports = async (req, res) => {
  try {
    const db = await getDB();
    const count = await db.collection('orders').countDocuments({});
    res.status(200).json({
      ok: true,
      db: process.env.MONGODB_DB,
      count
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message,
      hint: 'Check MONGODB_URI / MONGODB_DB envs and that mongodb is installed'
    });
  }
};
