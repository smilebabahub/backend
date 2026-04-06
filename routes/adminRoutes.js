// routes/adminRoutes.js
import express from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import authMiddleware from "../middleware/authMiddleWare.js";

// routes/adminRoutes.js
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
import { getLiveAnalytics, getHourlyViews } from "../controllers/analyticsController.js";

const router = express.Router();
router.use(authMiddleware, requireAdmin);

router.get("/overview",               getOverview);
router.get("/stats/trend",            getStatsTrend);
router.get("/stats/conversion",       getConversionStats);
router.get("/users",                  getUsers);
router.get("/users/:id",              getUserDetail);
router.patch("/users/:id/role",       setUserRole);
router.get("/subscriptions",          getSubscriptions);
router.get("/marketers",              getMarketers);
router.patch("/marketers/:id/payout", markMarketerPaidOut);
router.get("/ads",                    getAds);

// Email
router.post("/email/send",  sendAdminEmail);
router.post("/email/bulk",  sendBulkEmail);

// Analytics
router.get("/analytics/live",   getLiveAnalytics);
router.get("/analytics/hourly", getHourlyViews);

export default router;
