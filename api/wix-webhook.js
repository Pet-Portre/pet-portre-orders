// Accepts Wix order webhook, normalizes and upserts into Mongo
const { getDB } = require('../lib/db');

function nowISO() { return new Date().toISOString(); }
function upper(s) { return (s || '').toString().trim().toUpperCase(); }
function buildPlaceholderRef(channel, orderNumber) {
  return `${upper(channel || 'wix')}${orderNumber}`;
}

// Normalize Wix webhook payload into our order schema
function normalizeWix(payload) {
  const orderNumber = String(payload.orderNumber || payload.id || '').trim();
  const createdAt   = payload.createdAt || nowISO();
  const channel     = 'wix';

  const buyer = payload.buyerInfo || payload.customer || {};
  const shipping = payload.shippingInfo || {};
  const address = {
    line1: shipping.addressLine1 || '',
    line2: shipping.addressLine2 || '',
    city: shipping.city || '',
    state: shipping.subdivision || '',
    postalCode: shipping.postalCode || '',
    country: shipping.country || 'TR'
  };

  const items = (payload.lineItems || []).map(it => ({
    sku: (it.sku || '').trim(),
    name: it.name || '',
    qty: Number(it.quantity || 1),
    unitPrice: Number(it.price || 0),
    variants: {
      tshirtSize: it.options?.size || '',
      gender: it.options?.gender || '',
      color: it.options?.color || '',
      phoneModel: it.options?.phoneModel || '',
      portraitSize: it.options?.portraitSize || ''
    }
  }));

  const totals = {
    shipping: Number(payload.shippingPrice || 0),
    discount: Number(payload.discountAmount || 0),
    grandTotal: Number(payload.totalPrice || 0),
    currency: payload.currency || 'TRY'
  };

  const customer = {
    name: buyer.name || [buyer.firstName, buyer.lastName].filter(Boolean).join(' '),
    email: buyer.email || '',
    phone: buyer.phone || ''
  };

  return {
    orderNumber,
    channel,
    createdAt,
    customer,
    address,
    items,
    totals,
    delivery: {
      courier: null,
      trackingNumber: null,
      trackingUrl: null,
      status: 'pending',
      cargoDispatchDate: null,
      estimatedDelivery: null,
      dateDelivered: null,
      referenceId: null,
      referenceIdPlaceholder: buildPlaceholderRef(channel, orderNumber)
    },
    supplier: {},
    payment: {
      method: payload.paymentMethod || 'paytr',
      status: payload.paymentStatus || 'paid',
      paidAt: payload.paidAt || null
    },
    notes: ''
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  try {
    const db = await getDB();
    const payload = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    const normalized = normalizeWix(payload);

    if (!normalized.orderNumber) {
      res.status(400).json({ ok: false, error: 'orderNumber missing' });
      return;
    }

    await db.collection('orders').updateOne(
      { orderNumber: normalized.orderNumber },
      { $set: { ...normalized, updatedAt: nowISO() }, $setOnInsert: { createdAt: normalized.createdAt } },
      { upsert: true }
    );

    res.json({ ok: true, orderNumber: normalized.orderNumber, placeholderRef: normalized.delivery.referenceIdPlaceholder });
  } catch (err) {
    console.error('wix webhook error', err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
};
