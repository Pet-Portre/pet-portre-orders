// api/orders-flat.js
const { withDb } = require('../lib/db');

const HEADERS = [
  'orderNumber','createdAt','channel',
  'customerName','customerEmail','customerPhone',
  'addrLine1','addrLine2','city','postalCode','country',
  'itemSKU','itemName','itemQty','itemUnitPrice',
  'orderTotal','currency','notes'
];

module.exports = async (req, res) => {
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).send('GET only — orders-flat');
    }

    const key = req.query.key || req.headers['x-api-key'] || '';
    if (!process.env.EXPORT_TOKEN || key !== process.env.EXPORT_TOKEN) {
      return res.status(401).json({ ok:false, error: 'Unauthorized' });
    }

    const rows = await withDb(async (db) => {
      const col = db.collection('orders');
      const docs = await col
        .find({}, { sort: { createdAt: -1 } })
        .toArray();

      const out = [];
      for (const d of docs) {
        const base = {
          orderNumber: d.orderNumber || '',
          createdAt: new Date(d.createdAt || d._createdByWebhookAt || Date.now()).toISOString(),
          channel: d.channel || 'wix',
          customerName: d.customer?.name || [d.customer?.firstName, d.customer?.lastName].filter(Boolean).join(' ') || '',
          customerEmail: d.customer?.email || '',
          customerPhone: d.customer?.phone || '',
          addrLine1: d.address?.line1 || '',
          addrLine2: d.address?.line2 || '',
          city: d.address?.city || '',
          postalCode: d.address?.postalCode || '',
          country: d.address?.country || '',
          orderTotal: Number(d.totals?.total || 0),
          currency: d.totals?.currency || 'TRY',
          notes: d.notes || ''
        };

        const items = Array.isArray(d.items) && d.items.length ? d.items : [{sku:'',name:'',qty:'',unitPrice:''}];
        for (const it of items) {
          out.push([
            base.orderNumber, base.createdAt, base.channel,
            base.customerName, base.customerEmail, base.customerPhone,
            base.addrLine1, base.addrLine2, base.city, base.postalCode, base.country,
            it.sku || '', it.name || '', Number(it.qty || 0), Number(it.unitPrice || 0),
            base.orderTotal, base.currency, base.notes
          ]);
        }
      }
      return out;
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).json({ ok:true, headers: HEADERS, rows });
  } catch (err) {
    res.status(500).json({ ok:false, error: err.message });
  }
};
