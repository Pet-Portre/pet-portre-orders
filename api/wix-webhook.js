// api/wix-webhook.js
const { MongoClient, ServerApiVersion } = require('mongodb');

let _clientPromise;
async function getDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Missing MONGODB_URI');
  if (!_clientPromise) {
    _clientPromise = new MongoClient(uri, {
      serverApi: { version: '1', strict: true, deprecationErrors: true },
    }).connect();
  }
  const client = await _clientPromise;
  const dbName = process.env.MONGODB_DB || 'pet-portre';
  return client.db(dbName);
}

// small helpers
const isFilled = v => v !== undefined && v !== null && v !== '';
const pick = (...cands) => cands.find(isFilled);
const asNumber = v => (isNaN(Number(v)) ? undefined : Number(v));
const asDate = v => (v ? new Date(v) : undefined);

function toPhoneTR(v) {
  if (!v) return '';
  let s = String(v).replace(/\D+/g, '');
  if (s.length === 11 && s[0] === '0') s = s.slice(1);
  if (s.length === 10) return '0' + s;
  return s;
}

function normalizeOrder(raw) {
  // Try to locate the order object inside Wix payloads
  const order =
    raw?.order ??
    raw?.data?.order ??
    raw?.entity ??
    raw?.payload?.order ??
    raw;

  // Basic identifiers
  const orderNumber = String(
    pick(order?.number, order?.orderNumber, raw?.number, raw?.orderId, raw?.id, '')
  );

  const createdAt =
    asDate(pick(order?.createdDate, order?.dateCreated, raw?.createdAt)) ||
    new Date();

  // Buyer / shipping info
  const buyer =
    order?.buyerInfo ??
    order?.buyer ??
    raw?.buyer ??
    {};

  const shipping =
    order?.shippingInfo ??
    order?.shipping ??
    {};

  const shippingAddress =
    shipping?.address ??
    shipping?.shippingAddress ??
    buyer?.address ??
    {};

  const name =
    pick(
      shipping?.fullName,
      [buyer?.firstName, buyer?.lastName].filter(Boolean).join(' '),
      buyer?.fullName
    ) || '';

  // Price/totals
  const price = order?.priceData ?? order?.totals ?? {};
  const totals = {
    shipping: asNumber(pick(price?.shipping?.amount, price?.shippingPrice, order?.shippingPrice)) || 0,
    discount: asNumber(pick(price?.discount?.amount, price?.discountTotal)) || 0,
    grandTotal:
      asNumber(
        pick(
          price?.total?.amount,
          price?.totalPrice?.amount,
          order?.totalPrice?.amount,
          order?.totalAmount,
          order?.total
        )
      ) || 0,
    currency: pick(
      price?.totalPrice?.currency,
      price?.currency,
      order?.currency,
      'TRY'
    ),
  };

  // Line items
  const lineItems = order?.lineItems ?? order?.items ?? [];
  const items = Array.isArray(lineItems)
    ? lineItems.map(li => ({
        sku: pick(li?.sku, li?.catalogReference?.sku, ''),
        name: pick(li?.name, li?.productName, ''),
        qty: asNumber(li?.quantity) || 1,
        unitPrice: asNumber(
          pick(
            li?.price?.amount,
            li?.price,
            li?.itemPrice?.amount,
            li?.itemPrice
          )
        ) || 0,
        variants: {
          tshirtSize: li?.options?.tshirtSize ?? li?.variantOptions?.size ?? undefined,
          gender: li?.options?.gender ?? undefined,
          color: li?.options?.color ?? li?.variantOptions?.color ?? undefined,
          phoneModel: li?.options?.phoneModel ?? undefined,
          portraitSize: li?.options?.portraitSize ?? undefined,
        },
      }))
    : [];

  // Payment (best effort)
  const payment =
    order?.paymentInfo ??
    order?.payment ??
    raw?.payment ??
    {};
  const paymentMethod = pick(payment?.method, payment?.gateway, order?.paymentMethod, 'wix');

  // Deliveries (we’ll fill tracking later)
  const delivery = {
    courier: pick(order?.shippingProvider, shipping?.carrier, undefined),
    trackingNumber: pick(order?.trackingNumber, shipping?.trackingNumber, ''),
    status: pick(order?.fulfillmentStatus, order?.status, undefined),
  };

  // Customer contact
  const email = pick(order?.buyerEmail, buyer?.email, raw?.email, '');
  const phone = toPhoneTR(pick(buyer?.phone, shipping?.phone, order?.phone));

  const address1 =
    pick(
      shippingAddress?.addressLine1,
      shippingAddress?.addressLine,
      shippingAddress?.streetAddress,
      ''
    );

  return {
    channel: 'wix',
    orderNumber,
    createdAt,
    _createdByWebhookAt: new Date(),
    customer: {
      name,
      email,
      phone,
      address: {
        line1: address1,
        city: pick(shippingAddress?.city, shippingAddress?.cityName, ''),
        district: pick(shippingAddress?.district, ''),
        postcode: pick(shippingAddress?.postalCode, shippingAddress?.zip, ''),
        country: pick(shippingAddress?.country, shippingAddress?.countryCode, 'TR'),
      },
    },
    items,
    payment: { method: paymentMethod },
    delivery,
    supplier: {}, // empty placeholder; managed later in backoffice
    totals,
    notes: pick(order?.note, order?.buyerNote, ''),
    updatedAt: new Date(),
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).send('POST only');
  }

  // token gate
  const expected = process.env.WIX_WEBHOOK_TOKEN || '';
  const incoming = (req.query && req.query.token) || '';
  if (expected && incoming !== expected) {
    return res.status(401).json({ ok: false, error: 'bad token' });
  }

  // Parse JSON body safely
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body || '{}'); }
    catch (e) { return res.status(400).json({ ok: false, error: 'invalid JSON' }); }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'empty body' });
  }

  // Optional write guard
  const writeEnabled = String(process.env.MONGODB_WRITE_ENABLED || 'true').toLowerCase() === 'true';

  try {
    const db = await getDb();

    // Always persist raw payload for debugging/auditing
    await db.collection('raw_events').insertOne({
      source: 'wix',
      receivedAt: new Date(),
      headers: req.headers,
      query: req.query,
      body,
    });

    if (!writeEnabled) {
      return res.status(200).json({ ok: true, dryRun: true });
    }

    // Normalize + upsert into orders
    const doc = normalizeOrder(body);

    if (!doc.orderNumber) {
      // No order number — still accept but only keep raw event
      return res.status(202).json({
        ok: true,
        warning: 'missing orderNumber; raw event stored only',
      });
    }

    const up = await db.collection('orders').updateOne(
      { orderNumber: doc.orderNumber },
      {
        $setOnInsert: { createdAt: doc.createdAt },
        $set: {
          channel: doc.channel,
          _createdByWebhookAt: doc._createdByWebhookAt,
          customer: doc.customer,
          delivery: doc.delivery,
          items: doc.items,
          payment: doc.payment,
          supplier: doc.supplier,
          totals: doc.totals,
          notes: doc.notes,
          updatedAt: doc.updatedAt,
        },
      },
      { upsert: true }
    );

    return res.status(200).json({
      ok: true,
      upserted: Boolean(up.upsertedId),
      matched: up.matchedCount,
      modified: up.modifiedCount,
      orderNumber: doc.orderNumber,
    });
  } catch (err) {
    console.error('wix-webhook error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'server error' });
  }
};
