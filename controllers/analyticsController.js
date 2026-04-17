// controllers/analyticsController.js
// Handles page view tracking from the frontend and live stats for admin.

import { safeRedis } from "../lib/redis.js";
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
    const { path, referrer, country: bodyCountry } = req.body;
    if (!path) return;

    // Country resolution priority:
    //   1. Body param sent by frontend (from Redux — most reliable in production)
    //   2. Cloudflare cf-ipcountry header (works when behind CF proxy)
    //   3. "Unknown" fallback
    const cfCountry = (req.headers["cf-ipcountry"] || "").toUpperCase();
    const cfName =
      cfCountry === "NG" ? "Nigeria" : cfCountry === "GH" ? "Ghana" : null;

    // Normalise body country
    const bodyName =
      bodyCountry === "Nigeria"
        ? "Nigeria"
        : bodyCountry === "Ghana"
          ? "Ghana"
          : null;

    const countryName = bodyName ?? cfName ?? "Unknown";

    const ua = req.headers["user-agent"] || "";
    const device = detectDevice(ua);

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
// Cached for 15s in Redis — prevents 10 aggregations/minute when multiple
// admin tabs are open.
const LIVE_CACHE_KEY = "analytics:live";
const LIVE_CACHE_TTL = 15; // seconds

export const getLiveAnalytics = async (req, res) => {
  // For SSE we stream — can't cache at the HTTP level, but cache the DB work
  try {
    // Try cache first
    const cached = await safeRedis((c) => c.get(LIVE_CACHE_KEY));
    if (cached) {
      const data = JSON.parse(cached);
      // Merge fresh online count (always real-time)
      const { onlineUsers } = await import("../lib/socketHandler.js");
      data.onlineNow = onlineUsers?.size ?? 0;
      return res.status(200).json(data);
    }

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
      uniqueSessions,
      topReferrers,
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

      // Unique sessions in last 24h (by IP approximated via userId or sessionId)
      Analytics.aggregate([
        { $match: { createdAt: { $gte: last24h } } },
        { $group: { _id: { $ifNull: ["$userId", "$sessionId"] } } },
        { $count: "total" },
      ]),

      // Top referrers (last 24h)
      Analytics.aggregate([
        { $match: { createdAt: { $gte: last24h }, referrer: { $ne: null } } },
        { $group: { _id: "$referrer", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 5 },
      ]),
    ]);

    // Active socket connections = currently online users
    const onlineUsers = getOnlineUsers();
    const onlineCount = onlineUsers.size;
    const onlineUserIds = Array.from(onlineUsers.keys());

    const payload = {
      live: {
        onlineNow: onlineCount,
        onlineUsers: onlineUserIds,
        views5min,
        views1h,
        views24h,
        uniqueSessions: uniqueSessions[0]?.total ?? 0,
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
        byReferrer: topReferrers.map((r) => ({
          referrer: r._id,
          count: r.count,
        })),
      },
      recentActivity,
    };

    // Cache breakdown + recent activity for 15s (online count is always fresh)
    const cachePayload = {
      ...payload,
      live: { ...payload.live, onlineNow: 0, onlineUsers: [] },
    };
    safeRedis((c) =>
      c.setEx(LIVE_CACHE_KEY, LIVE_CACHE_TTL, JSON.stringify(cachePayload)),
    ).catch(() => {});

    res.status(200).json(payload);
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
