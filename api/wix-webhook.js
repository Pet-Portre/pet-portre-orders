// File: api/wix-webhook.js
// POST-only webhook for Wix "Order placed" automation.
// Auth: ?token=... must match process.env.WIX_WEBHOOK_TOKEN

const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'pet-portre';
const expectedToken = process.env.WIX_WEBHOOK_TOKEN;

let clientPromise;
function getClient() {
  if (!clientPromise) {
    if (!uri) throw new Error('MONGODB_URI not set');
    clientPromise = new MongoClient(uri, { maxPoolSize: 5 }).connect();
  }
  return clientPromise;
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only');
    }

    // Simple token guard
    const token = (req.query && req.query.token) || '';
    if (!expectedToken || token !== expectedToken) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }

    // Parse body (Wix sends JSON)
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const now = new Date();

    // Connect
    const client = await getClient();
    const db = client.db(dbName);

    // Always archive the raw event for debugging
    await db.collection('raw_events').insertOne({
      source: 'wix',
      type: 'order_placed',
      receivedAt: now,
      body
    });

    // Lenient extraction (Wix payloads can vary)
    const o = body.order || body; // sometimes wrapped under "order"
    const orderNumber =
      String(
        o.orderNumber ?? o.number ?? o.id ?? o._id ?? (o.cartId || '')
      ) || ('wix-' + Date.now());

    // Customer
    const customer = {
      name: o.customerName || o.buyerName || [o.firstName, o.lastName].filter(Boolean).join(' ') || '',
      email: o.email || (o.buyer && o.buyer.email) || '',
      phone: o.phone || (o.buyer && o.buyer.phone) || '',
      address: {
        line1:
          (o.shippingAddress && (o.shippingAddress.addressLine1 || o.shippingAddress.address1)) ||
          (o.address && (o.address.addressLine1 || o.address.address1)) ||
          o.addressLine1 || '',
        city:
          (o.shippingAddress && o.shippingAddress.city) ||
          (o.address && o.address.city) || '',
        district:
          (o.shippingAddress && (o.shippingAddress.suburb || o.shippingAddress.district)) ||
          (o.address && (o.address.suburb || o.address.district)) || '',
        postcode:
          (o.shippingAddress && (o.shippingAddress.postalCode || o.shippingAddress.zip)) ||
          (o.address && (o.address.postalCode || o.address.zip)) || '',
        country:
          (o.shippingAddress && (o.shippingAddress.country || o.shippingAddress.countryCode)) ||
          (o.address && (o.address.country || o.address.countryCode)) || ''
      }
    };

    // Items
    const lineItems = o.lineItems || o.items || [];
    const items = lineItems.map(li => ({
      name: li.name || li.productName || '',
      sku: li.sku || li.variantSku || '',
      qty: Number(li.quantity || li.qty || 1),
      unitPrice: Number(
        (li.price && (li.price.amount || li.price.value)) ??
        li.unitPrice ??
        li.price ??
        0
      ),
      variants: {
        tshirtSize: li.options && (li.options.size || li.options.tshirtSize),
        gender: li.options && li.options.gender,
        color: li.options && (li.options.color || li.options.colour),
        phoneModel: li.options && (li.options.phoneModel || li.options.model),
        portraitSize: li.options && (li.options.portraitSize || li.options.size)
      }
    }));

    // Totals
    const totals = {
      currency:
        (o.currency && (o.currency.code || o.currency)) ||
        (o.priceSummary && o.priceSummary.currency) || 'TRY',
      grandTotal:
        Number(
          o.grandTotal ??
          (o.priceSummary && (o.priceSummary.total || o.priceSummary.grandTotal)) ??
          o.totalPrice ??
          0
        ),
      shipping:
        Number(
          o.shippingPrice ??
          (o.priceSummary && o.priceSummary.shipping) ?? 0
        ),
      discount:
        Number(
          o.discount ??
          (o.priceSummary && o.priceSummary.discount) ?? 0
        )
    };

    const doc = {
      channel: 'wix',
      orderNumber,
      createdAt: o.createdAt ? new Date(o.createdAt) : now,
      updatedAt: now,
      customer,
      items,
      delivery: {
        courier: o.shippingCarrier || '',
        trackingNumber: o.trackingNumber || '',
        status: o.fulfillmentStatus || '',
      },
      payment: {
        method: o.paymentMethod || o.gateway || '',
        status: o.paymentStatus || '',
      },
      totals,
      notes: o.note || o.notes || ''
    };

    // Upsert by orderNumber
    await db.collection('orders').updateOne(
      { orderNumber },
      { $set: doc, $setOnInsert: { _createdByWebhookAt: now } },
      { upsert: true }
    );

    return res.status(200).json({ ok: true, orderNumber, receivedAt: now.toISOString() });
  } catch (err) {
    console.error('wix-webhook error:', err);
    return res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
};
