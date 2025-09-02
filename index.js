// index.js
module.exports = (req, res) => {
  res.status(200).json({
    ok: true,
    app: "pet-portre-orders",
    hint: "Use /api/health, /api/sync, /api/dhl-create-order, /api/dhl-track-order, /api/wix-webhook"
  });
};
