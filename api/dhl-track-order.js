// Poll DHL "Standard Query" for a referenceId, update delivery fields in Mongo.
const { ObjectId } = require('mongodb');
const { getDB } = require('../lib/db');
const { standardQuery } = require('../lib/dhl');

function nowISO(){return new Date().toISOString();}

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ ok:false, error:'Method not allowed' }); return;
  }
  try {
    const db = await getDB();
    const input = req.method==='GET'?req.query:(typeof req.body==='object'?req.body:JSON.parse(req.body||'{}'));
    let { referenceId, orderNumber, id } = input;

    let order;
    if (!referenceId) {
      order = orderNumber
        ? await db.collection('orders').findOne({ orderNumber:String(orderNumber) })
        : id ? await db.collection('orders').findOne({ _id:new ObjectId(String(id)) }) : null;
      if (!order) { res.status(404).json({ ok:false,error:'Order not found or referenceId missing' }); return; }
      referenceId = order.delivery?.referenceId || order.delivery?.referenceIdPlaceholder;
    }

    const q = await standardQuery(referenceId);

    const update = {
      'delivery.courier': 'DHL',
      'delivery.status': q.status,
      'delivery.trackingNumber': q.trackingNumber,
      'delivery.trackingUrl': q.trackingUrl,
      'delivery.cargoDispatchDate': q.cargoDispatchDate,
      'delivery.dateDelivered': q.dateDelivered,
      updatedAt: nowISO()
    };

    if (order) {
      await db.collection('orders').updateOne({ _id: order._id },{ $set:update });
    } else {
      await db.collection('orders').updateOne(
        { $or:[ {'delivery.referenceId':referenceId}, {'delivery.referenceIdPlaceholder':referenceId} ] },
        { $set:update }
      );
    }

    res.json({ ok:true, referenceId, ...q });
  } catch(err){
    console.error('dhl track-order error', err);
    res.status(500).json({ ok:false, error:String(err.message||err) });
  }
};
