// /index.js  (root)
module.exports = async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    const method = req.method.toUpperCase();

    // Inline health so it never depends on other files
    if (method === 'GET' && (pathname === '/' || pathname === '/api/health')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        ok: true,
        service: 'pet-portre-orders',
        time: new Date().toISOString(),
      }));
      return;
    }

    // Lazy loaders so we only require the file when the route is used
    const loaders = {
      'GET /api/sync':            () => require('./api/sync.js'),
      'POST /api/wix-webhook':    () => require('./api/wix-webhook.js'),
      'POST /api/dhl-create-order': () => require('./api/dhl-create-order.js'),
      'GET /api/dhl-track-order': () => require('./api/dhl-track-order.js'),
    };

    const key =
      method === 'GET' && pathname.startsWith('/api/dhl-track-order')
        ? 'GET /api/dhl-track-order'
        : `${method} ${pathname}`;

    const load = loaders[key];
    if (!load) {
      res.statusCode = 404;
      res.end('Not Found');
      return;
    }

    const handler = load();              // require() happens here
    const maybe = handler(req, res);     // handler can be sync or async
    if (maybe && typeof maybe.then === 'function') await maybe;
  } catch (err) {
    console.error('index.js error:', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
  }
};
