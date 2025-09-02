// Minimal router that forwards to your /api/* handlers
const url = require('url');

const health = require('./api/health.js');
const sync = require('./api/sync.js');
const wixWebhook = require('./api/wix-webhook.js');
const dhlCreateOrder = require('./api/dhl-create-order.js');
const dhlTrackOrder = require('./api/dhl-track-order.js');

const routes = new Map([
  ['GET /', health],
  ['GET /api/health', health],
  ['GET /api/sync', sync],
  ['POST /api/wix-webhook', wixWebhook],
  ['POST /api/dhl-create-order', dhlCreateOrder],
  ['GET /api/dhl-track-order', dhlTrackOrder],
]);

module.exports = async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const key = `${req.method.toUpperCase()} ${pathname}`;

  // Exact match first
  let handler = routes.get(key);

  // If not an exact match, allow /api/dhl-track-order?… etc
  if (!handler && pathname.startsWith('/api/dhl-track-order') && req.method === 'GET') {
    handler = dhlTrackOrder;
  }

  if (!handler) {
    res.statusCode = 404;
    return res.end('Not Found');
  }

  try {
    // your handlers are (req,res) style; they may be sync or async
    const maybePromise = handler(req, res);
    if (maybePromise && typeof maybePromise.then === 'function') {
      await maybePromise;
    }
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.end('Internal Server Error');
  }
};
