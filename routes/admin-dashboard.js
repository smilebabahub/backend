// backend/routes/admin-dashboard.js
//
// Admin dashboard overview endpoint. Aggregates everything you see on the
// /admin home page in one round-trip.
//
// Mount with: app.use("/admin/dashboard", adminDashboardRoutes)
//
// Routes:
//   GET    /admin/dashboard/overview     → users + ads + subscriptions + promotions

import express from "express";

import User from "../models/user.js";
import Ad from "../models/adModel.js";
import Subscription from "../models/Subscription.js";

import { verifyAuth, verifyAdmin } from "../middleware/auth.js";
import { getOverviewStats } from "../services/promotionStats.js";

const router = express.Router();
router.use(verifyAuth, verifyAdmin);

// ─── Helpers ──────────────────────────────────────────────────────────────
const startOfMonth = () => {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
};

// ═════════════════════════════════════════════════════════════════════════
// GET /admin/dashboard/overview
// ═════════════════════════════════════════════════════════════════════════
router.get("/overview", async (req, res) => {
  try {
    // Run all aggregations in parallel
    const [
      usersTotal,
      usersNewThisMonth,
      adsActive,
      adsTotal,
      subscriptionAgg,
      promotionStats,
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ createdAt: { $gte: startOfMonth() } }),
      Ad.countDocuments({ status: "active" }),
      Ad.countDocuments({}),

      Subscription.aggregate([
        { $match: { status: "active" } },
        {
          $group: {
            _id: "$currency",
            count: { $sum: 1 },
            monthlyRevenue: { $sum: "$amount" },
          },
        },
      ]),

      getOverviewStats(),
    ]);

    // Aggregate subscriptions into a single object (split by currency)
    const subscriptions = {
      count: 0,
      revenue: {},
    };
    for (const s of subscriptionAgg) {
      subscriptions.count += s.count;
      subscriptions.revenue[s._id || "GHS"] = {
        revenue: s.monthlyRevenue,
        count: s.count,
      };
    }

    res.json({
      users: {
        total: usersTotal,
        newThisMonth: usersNewThisMonth,
      },
      ads: {
        active: adsActive,
        total: adsTotal,
      },
      subscriptions,
      promotions: {
        revenue: promotionStats.revenue,
        counts: promotionStats.counts,
        pendingApprovals: promotionStats.pendingApprovals,
        conversion: promotionStats.conversion,
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[admin/dashboard/overview]", err);
    res.status(500).json({ message: err.message });
  }
});

export default router;
