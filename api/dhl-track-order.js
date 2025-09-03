// Simple proxy wrapper to standard query provider (by tracking or reference)
export default async function handler(req, res) {
  try {
    const tracking = (req.query?.tracking || "").toString();
    const ref = (req.query?.ref || "").toString();
    if (!tracking && !ref) return res.status(400).json({ ok: false, error: "tracking or ref required" });

    const base = process.env.DHL_STANDARD_QUERY_URL;
    if (!base) return res.status(500).json({ ok: false, error: "DHL_STANDARD_QUERY_URL missing" });

    const url = new URL(base);
    if (tracking) url.searchParams.set("tracking", tracking);
    if (ref) url.searchParams.set("ref", ref);

    const r = await fetch(url);
    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).json({ ok: false, error: t });
    }

    const j = await r.json();
    // Normalize a bit
    return res.status(200).json({
      ok: true,
      status: j.status || "",
      deliveredAt: j.deliveredAt || "",
      trackingNumber: j.trackingNumber || tracking || "",
      raw: j
    });
  } catch (e) {
    console.error("dhl-track-order error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
