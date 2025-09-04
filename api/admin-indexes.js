// api/admin-indexes.js
const { withDb } = require('../lib/db');

module.exports = async (req, res) => {
  try {
    const key = req.query.key || '';
    if (!process.env.ADMIN_TOKEN || key !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok:false, error:'Unauthorized' });
    }

    const report = await withDb(async (db) => {
      const col = db.collection('orders');
      // Use default name so we don’t clash with existing "orderNumber_1"
      await col.createIndex({ orderNumber: 1 }, { unique: true });
      return { created: ['orders.orderNumber unique'] };
    });

    res.json({ ok:true, report });
  } catch (e) {
    // harmless if it already exists with a different name/options
    return res.json({ ok:false, error: e.message });
  }
};
