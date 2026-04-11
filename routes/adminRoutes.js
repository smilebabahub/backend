// routes/adminRoutes.js
import express from "express";
import { authenticate } from "../middleware/authMiddleWare.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  getOverview,
  getUsers,
  getUserDetail,
  setUserRole,
  getSubscriptions,
  getMarketers,
  markMarketerPaidOut,
  getAds,
  getStatsTrend,
  getConversionStats,
  sendAdminEmail,
  sendBulkEmail,
} from "../controllers/adminController.js";
import {
  getLiveAnalytics,
  getHourlyViews,
} from "../controllers/analyticsController.js";
import {
  getPeriodAnalytics,
  getMarketerStats,
  getSystemHealth,
  generateReport,
} from "../controllers/adminController.js";

const router = express.Router();
router.use(authenticate, requireAdmin);

router.get("/overview", getOverview);
router.get("/stats/trend", getStatsTrend);
router.get("/stats/conversion", getConversionStats);
router.get("/users", getUsers);
router.get("/users/:id", getUserDetail);
router.patch("/users/:id/role", setUserRole);
router.get("/subscriptions", getSubscriptions);
router.get("/marketers", getMarketers);
router.patch("/marketers/:id/payout", markMarketerPaidOut);
router.get("/ads", getAds);

// Email
router.post("/email/send", sendAdminEmail);
router.post("/email/bulk", sendBulkEmail);

// Analytics
router.get("/analytics/live", getLiveAnalytics);
router.get("/analytics/hourly", getHourlyViews);
router.get("/analytics/period", authenticate, requireAdmin, getPeriodAnalytics);
router.get("/marketers/stats", authenticate, requireAdmin, getMarketerStats);
router.get("/system/health", authenticate, requireAdmin, getSystemHealth);
router.get("/system/report", authenticate, requireAdmin, generateReport);

// ── /admin/live — legacy endpoint that some clients call directly ──────────
// Accepts ?token= query param since EventSource can't send headers.
// Returns 204 (no content) for non-admin tokens so EventSource clients
// receive a successful HTTP response and stop reconnecting immediately.
import jwt from "jsonwebtoken";
router.get(
  "/live",
  (req, res, next) => {
    const rawToken =
      req.query.token ?? req.headers.authorization?.split(" ")[1];
    if (!rawToken)
      return res.status(401).json({ message: "Not authenticated" });

    // Try to verify as a user/admin token
    try {
      const decoded = jwt.verify(rawToken, process.env.JWT_ACCESS_SECRET);
      req.user = { ...decoded, userId: decoded.userId ?? decoded.id };
      return next(); // valid user token — proceed to requireAdmin + getLiveAnalytics
    } catch {
      // Not a valid user token (e.g. marketer token with different secret).
      // Return 204 so the EventSource client treats it as "connected but empty"
      // and stops the retry loop — far better than 401 every 4 seconds.
      console.warn(
        "[admin/live] non-user token blocked — returning 204 to stop retry",
      );
      return res.status(204).end();
    }
  },
  requireAdmin,
  getLiveAnalytics,
);

export default router;
