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
  let handler = routes.get(key);
  if (!handler && pathname.startsWith('/api/dhl-track-order') && req.method === 'GET') {
    handler = dhlTrackOrder;
  }
  if (!handler) { res.statusCode = 404; return res.end('Not Found'); }
  try {
    const maybe = handler(req, res);
    if (maybe && typeof maybe.then === 'function') await maybe;
  } catch (e) {
    console.error(e); res.statusCode = 500; res.end('Internal Server Error');
  }
};
