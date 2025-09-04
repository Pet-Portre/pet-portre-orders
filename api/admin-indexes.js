// File: api/admin-indexes.js
const { withDb } = require('../lib/db');

module.exports = async (req, res) => {
  const key = req.query.key || req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_TOKEN) return res.status(401).json({ ok:false, error:'Unauthorized' });

  try {
    await withDb(async (db) => {
      const col = db.collection('orders');
      await col.createIndex({ orderNumber: 1 }, { unique: true, name: 'uniq_orderNumber' });
      await col.createIndex({ createdAt: -1 }, { name: 'createdAt_desc' });
    });
    res.json({ ok:true, ensured:['uniq_orderNumber','createdAt_desc'] });
  } catch (e) {
    res.status(500).json({ ok:false, error:e.message });
  }
};
