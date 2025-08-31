// Create DHL order for a given orderNumber, update Mongo with official referenceId/tracking no.
const { ObjectId } = require('mongodb');
const { getDB } = require('../lib/db');
const { createOrder } = require('../lib/dhl');

function nowISO(){return new Date().toISOString();}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok:false, error:'Method not allowed' }); return;
  }
  try {
    const db = await getDB();
    const body = typeof req.body==='object'?req.body:JSON.parse(req.body||'{}');
    const { orderNumber, id } = body;

    let order = orderNumber
      ? await db.collection('orders').findOne({ orderNumber: String(orderNumber) })
      : id ? await db.collection('orders').findOne({ _id:new ObjectId(String(id)) }) : null;

    if (!order) { res.status(404).json({ ok:false, error:'Order not found' }); return; }

    const result = await createOrder(order);

    const update = {
      'delivery.courier': 'DHL',
      updatedAt: nowISO()
    };
    if (result.referenceId) update['delivery.referenceId']=result.referenceId;
    if (result.trackingNumber) update['delivery.trackingNumber']=result.trackingNumber;

    await db.collection('orders').updateOne({ _id: order._id },{ $set:update });

    res.json({
      ok:true,
      orderNumber: order.orderNumber,
      referenceId: result.referenceId || order.delivery?.referenceId || order.delivery?.referenceIdPlaceholder,
      trackingNumber: result.trackingNumber || null,
      raw: result.data
    });
  } catch(err){
    console.error('dhl create-order error', err);
    res.status(500).json({ ok:false, error:String(err.message||err) });
  }
};
