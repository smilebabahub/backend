// controllers/analyticsController.js
// Handles page view tracking from the frontend and live stats for admin.

import Analytics from "../models/analytics.js";
import { onlineUsers } from "../lib/socketHandler.js";

// Inline IP resolver — avoids missing-file dependency on resolveIp.js
function resolveClientIP(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return cf.trim();
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "";
}

// Expose online users count directly from the socketHandler map
function getOnlineUsers() {
  return onlineUsers;
}

// ── Helper: detect device type from UA ───────────────────────────────────
function detectDevice(ua = "") {
  if (/tablet|ipad/i.test(ua)) return "tablet";
  if (/mobile|android|iphone/i.test(ua)) return "mobile";
  return "desktop";
}

// ── POST /analytics ────────────────────────────────────────────────────────
// Called by the frontend on every page navigation.
// Fast — fire-and-forget from the client, so it never blocks page loads.
export const trackPageView = async (req, res) => {
  // Respond immediately — never block the client
  res.status(202).end();

  try {
    const { path, referrer } = req.body;
    if (!path) return;

    const country = (req.headers["cf-ipcountry"] || "").toUpperCase();
    const countryName =
      country === "NG"
        ? "Nigeria"
        : country === "GH"
          ? "Ghana"
          : country || "Unknown";

    const ua = req.headers["user-agent"] || "";
    const device = detectDevice(ua);

    // userId is optional — only present for logged-in users who send the token
    const userId = req.user?.userId ?? null;

    await Analytics.create({
      path: String(path).slice(0, 200),
      country: countryName,
      userId,
      device,
      referrer: referrer ? String(referrer).slice(0, 200) : null,
    });
  } catch (err) {
    // Non-fatal — never surface analytics errors to users
    console.error("[analytics] trackPageView error:", err.message);
  }
};

// ── GET /admin/analytics/live ──────────────────────────────────────────────
// Returns live stats for the admin dashboard.
// Called every 30s by the admin panel via SSE or polling.
export const getLiveAnalytics = async (req, res) => {
  try {
    const now = new Date();
    const last24h = new Date(now - 24 * 60 * 60 * 1000);
    const last1h = new Date(now - 60 * 60 * 1000);
    const last5min = new Date(now - 5 * 60 * 1000);

    const [
      views24h,
      views1h,
      views5min,
      byCountry,
      byDevice,
      byPage,
      recentActivity,
    ] = await Promise.all([
      // Total page views
      Analytics.countDocuments({ createdAt: { $gte: last24h } }),
      Analytics.countDocuments({ createdAt: { $gte: last1h } }),
      Analytics.countDocuments({ createdAt: { $gte: last5min } }),

      // Views by country (last 24h)
      Analytics.aggregate([
        { $match: { createdAt: { $gte: last24h } } },
        { $group: { _id: "$country", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),

      // Views by device (last 24h)
      Analytics.aggregate([
        { $match: { createdAt: { $gte: last24h } } },
        { $group: { _id: "$device", count: { $sum: 1 } } },
      ]),

      // Top pages (last 24h)
      Analytics.aggregate([
        { $match: { createdAt: { $gte: last24h } } },
        { $group: { _id: "$path", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]),

      // Last 20 page views for live feed
      Analytics.find({ createdAt: { $gte: last1h } })
        .sort({ createdAt: -1 })
        .limit(20)
        .select("path country device createdAt userId")
        .lean(),
    ]);

    // Active socket connections = currently online users
    const onlineUsers = getOnlineUsers();
    const onlineCount = onlineUsers.size;
    const onlineUserIds = Array.from(onlineUsers.keys());

    res.status(200).json({
      live: {
        onlineNow: onlineCount,
        onlineUsers: onlineUserIds,
        views5min,
        views1h,
        views24h,
      },
      breakdown: {
        byCountry: byCountry.map((c) => ({
          country: c._id || "Unknown",
          count: c.count,
        })),
        byDevice: byDevice.map((d) => ({
          device: d._id || "unknown",
          count: d.count,
        })),
        byPage: byPage.map((p) => ({ path: p._id, count: p.count })),
      },
      recentActivity,
    });
  } catch (error) {
    console.error("getLiveAnalytics error:", error);
    res.status(500).json({ message: "Failed to load analytics" });
  }
};

// ── GET /admin/analytics/hourly ────────────────────────────────────────────
// Views bucketed by hour for the last 24h — used for the activity chart.
export const getHourlyViews = async (req, res) => {
  try {
    const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const hourly = await Analytics.aggregate([
      { $match: { createdAt: { $gte: last24h } } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%dT%H:00:00",
              date: "$createdAt",
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.status(200).json({ hourly });
  } catch (error) {
    res.status(500).json({ message: "Failed to load hourly views" });
  }
};
