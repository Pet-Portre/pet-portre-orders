// api/wix-webhook.js
// Tolerant Wix webhook -> Mongo upsert (handles "Entire payload" + older shapes)

const { withDb } = require('../lib/db');
const qs = require('querystring');

/* ---------- helpers ---------- */
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const first = (...xs) => xs.find(v => v !== undefined && v !== null && v !== '');
const asBool = (v) => v === true || String(v).toLowerCase() === 'true';

// Breadth-first deep search for a key that matches a regex; returns the value at that key.
function deepFindByKey(root, keyRegex) {
  if (!root) return undefined;
  const q = [root];
  const seen = new Set();
  while (q.length) {
    const cur = q.shift();
    if (!isObj(cur) && !Array.isArray(cur)) continue;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const keys = Object.keys(cur);
    for (const k of keys) {
      if (keyRegex.test(k)) return cur[k];
      const val = cur[k];
      if (isObj(val) || Array.isArray(val)) q.push(val);
    }
  }
  return undefined;
}

// Safely coerce a date/time from many shapes
function coerceDate(x) {
  if (!x) return null;
  const d = new Date(x);
  return isNaN(d.getTime()) ? null : d;
}

// Join address parts into one line
function joinAddress(parts) {
  return parts
    .map(x => (x ?? '').toString().trim())
    .filter(Boolean)
    .join(', ')
    .replace(/\s+,/g, ',') // tidy accidental spaces before commas
    .trim();
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).send('POST only — wix-webhook');
    }

    /* ---------- auth ---------- */
    const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const token =
      req.query.token ||
      req.headers['x-api-key'] ||
      bearer || '';
    if (!process.env.WIX_WEBHOOK_TOKEN || token !== process.env.WIX_WEBHOOK_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    /* ---------- body parsing (json, urlencoded, raw) ---------- */
    let body = req.body;
    if (Buffer.isBuffer(body)) body = body.toString('utf8');

    if (typeof body === 'string' && body.trim()) {
      try {
        body = JSON.parse(body);
      } catch {
        const maybe = qs.parse(body);
        const onlyKey = Object.keys(maybe || {})[0];
        // Sometimes Wix posts a single field whose value is JSON
        try { body = JSON.parse(maybe[onlyKey]); } catch { body = maybe; }
      }
    }
    body = body || {};

    // quick ping test
    if (asBool(body.ping)) return res.json({ ok: true, pong: true });

    /* ---------- normalize known wrappers ---------- */
    // Accept: { order }, { data:{order}}, { data:{...}}, { payload:{order}}, { payload:{...}}, flat {...}
    const raw =
      body.order ||
      body.data?.order ||
      body.data ||
      body.payload?.order ||
      body.payload ||
      body;

    /* ---------- order number (look in both API-ish and human keys) ---------- */
    let orderNumber = first(
      raw?.number,
      raw?.orderNumber,
      raw?.id, raw?._id, raw?.orderId,
      raw?.reference, raw?.reference_number, raw?.referenceNumber
    );

    if (!orderNumber) {
      // Look for human-readable key: "Order number"
      const maybe = deepFindByKey(body, /(^|\s)order\s*number(\s|$)/i);
      if (maybe !== undefined && maybe !== null && maybe !== '') orderNumber = maybe;
    }

    if (!orderNumber) {
      // as an absolute last resort, try invoice/order ids that Wix sometimes includes
      orderNumber = first(
        deepFindByKey(body, /(^|\s)invoice\s*id(\s|$)/i),
        deepFindByKey(body, /(^|\s)checkout\s*id(\s|$)/i),
        deepFindByKey(body, /(^|\s)payment\s*id(\s|$)/i),
      );
    }

    if (!orderNumber) {
      // Don’t generate a fake number anymore; fail fast so we spot payload shape issues
      return res.status(400).json({ ok: false, error: 'Missing order number in payload' });
    }

    /* ---------- createdAt ---------- */
    let createdAt =
      coerceDate(first(raw?.createdAt, raw?.createdDate, body?.eventTime)) ||
      coerceDate(deepFindByKey(body, /date\s*created|created\s*at/i)) ||
      new Date();

    /* ---------- customer ---------- */
    const customer =
      first(raw?.buyerInfo, raw?.customer, body.customer) ||
      {
        // last-ditch try: “Shipping destination contact …” / “Contact …”
        firstName: deepFindByKey(body, /shipping\s+destination\s+contact\s+first\s*name|contact\s+first\s*name/i),
        lastName:  deepFindByKey(body, /shipping\s+destination\s+contact\s+last\s*name|contact\s+last\s*name/i),
        email:     first(deepFindByKey(body, /customer\s*email|contact\s*email/i)),
        phone:     first(deepFindByKey(body, /contact\s*phone|shipping\s+destination\s+contact\s+phone/i))
      };

    /* ---------- items / line items ---------- */
    let items =
      (Array.isArray(raw?.lineItems) ? raw.lineItems : null) ||
      (Array.isArray(raw?.items) ? raw.items : null) ||
      (Array.isArray(deepFindByKey(body, /ordered\s*items/i)) ? deepFindByKey(body, /ordered\s*items/i) : []);

    // Normalize items minimally (SKU/name/qty/price)
    items = (Array.isArray(items) ? items : []).map(it => ({
      sku:
        first(it?.sku, it?.SKU, it?.productSKU, it?.catalogReference?.sku) || '',
      name:
        first(it?.name, it?.productName, it?.title) || '',
      quantity:
        Number(first(it?.quantity, it?.qty, 1)) || 1,
      // prefer explicit unit price; else total price before tax; else zero
      unitPrice:
        Number(
          first(
            it?.price?.value,
            it?.priceBeforeTax?.value,
            it?.totalPriceBeforeTax?.value // we’ll divide if we must
          )
        ) || 0,
      totalPrice:
        Number(
          first(
            it?.totalPrice?.value,
            it?.totalPriceBeforeTax?.value,
            it?.price?.value
          )
        ) || 0,
      // pass through original in case we need more later
      _raw: it
    })).map(it => {
      // if we only had a total but not unit, back-compute the unit
      if (!it.unitPrice && it.totalPrice && it.quantity) {
        it.unitPrice = Math.round((it.totalPrice / it.quantity) * 100) / 100;
      }
      return it;
    });

    /* ---------- address (single full string + components) ---------- */
    const formatted = first(
      deepFindByKey(body, /shipping\s*formatted\s*address/i),
      deepFindByKey(body, /billing\s*formatted\s*address/i)
    );

    const address = {
      fullAddress: formatted || joinAddress([
        deepFindByKey(body, /shipping\s*address\s*line\b(?!\s*\d)/i),
        deepFindByKey(body, /shipping\s*address\s*line\s*2/i),
        deepFindByKey(body, /shipping\s*address\s*city/i),
        deepFindByKey(body, /shipping\s*address\s*subdivision/i),
        deepFindByKey(body, /shipping\s*address\s*zip|postal\s*code/i),
        deepFindByKey(body, /shipping\s*address\s*country/i)
      ]),
      city:        first(deepFindByKey(body, /shipping\s*address\s*city/i)),
      region:      first(deepFindByKey(body, /shipping\s*address\s*subdivision/i)),
      postcode:    first(deepFindByKey(body, /shipping\s*address\s*(zip|postal)\s*code/i)),
      country:     first(deepFindByKey(body, /shipping\s*address\s*country/i))
    };

    /* ---------- totals ---------- */
    const totals =
      first(raw?.totals, raw?.orderTotals) || {
        subtotal: deepFindByKey(body, /order\s*subtotal\s*value/i),
        shipping: deepFindByKey(body, /order\s*total\s*shipping\s*amount\s*value|shipping\s*amount\s*value/i),
        tax:      deepFindByKey(body, /order\s*total\s*tax\s*value|tax\s*value/i),
        discount: deepFindByKey(body, /order\s*total\s*discount\s*value|discount\s*amount\s*value/i),
        total:    deepFindByKey(body, /order\s*total\s*value|total\s*price\s*value/i),
        currency: first(
          deepFindByKey(body, /order\s*total\s*currency/i),
          deepFindByKey(body, /total\s*price\s*currency/i),
        )
      };

    /* ---------- notes ---------- */
    const notes = first(
      raw?.notes,
      body?.notes,
      deepFindByKey(body, /checkout\s*custom\s*fields/i)
    ) || '';

    /* ---------- build doc ---------- */
    const doc = {
      orderNumber: String(orderNumber),
      channel: raw?.channel || 'wix',
      createdAt,
      customer,
      address,
      items,
      totals,
      notes,
      _createdByWebhookAt: new Date(),
      _firstSeenAt: new Date()
    };

    /* ---------- upsert ---------- */
    const result = await withDb(async (db) => {
      const col = db.collection('orders');
      return col.updateOne(
        { orderNumber: doc.orderNumber },
        {
          $setOnInsert: {
            orderNumber: doc.orderNumber,
            channel: doc.channel,
            createdAt: doc.createdAt,
            _firstSeenAt: doc._firstSeenAt
          },
          $set: {
            customer: doc.customer,
            address: doc.address,
            items: doc.items,
            totals: doc.totals,
            notes: doc.notes,
            _createdByWebhookAt: doc._createdByWebhookAt
          }
        },
        { upsert: true }
      );
    });

    return res.json({
      ok: true,
      orderNumber: doc.orderNumber,
      upserted: result.upsertedCount === 1,
      matched: result.matchedCount,
      modified: result.modifiedCount
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
