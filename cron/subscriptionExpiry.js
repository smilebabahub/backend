// cron/subscriptionExpiry.js
// Runs daily at 08:00 WAT (Africa/Accra = GMT+0, same as WAT for scheduling).
// Tasks:
//   1. Notify vendors 7d / 3d / 1d before their subscription expires
//   2. Downgrade expired vendors to "guest" role
//   3. Write a daily platform stats snapshot to the Stats collection
//      (enables trend charts in admin without live aggregations)

import cron from "node-cron";
import User from "../models/user.js";
import Ad from "../models/adModel.js";
import Notification from "../models/notificationModel.js";
import Purchase from "../models/purchaseModel.js";
import Stats from "../models/statsModel.js";

const NOTIFY_AT_DAYS = [7, 3, 1];

// cron/subscriptionExpiry.js
// Runs daily at 08:00 WAT (Africa/Accra = GMT+0, same as WAT for scheduling).
// Tasks:
//   1. Notify vendors 7d / 3d / 1d before their subscription expires
//   2. Downgrade expired vendors to "guest" role
//   3. Write a daily platform stats snapshot to the Stats collection
//      (enables trend charts in admin without live aggregations)


// ── 1 + 2: Subscription expiry notifications + downgrade ──────────────────
async function checkExpiringSubscriptions() {
  console.log("[cron] Running subscription expiry check…");
  const now = new Date();

  for (const daysLeft of NOTIFY_AT_DAYS) {
    const windowStart = new Date(now.getTime() + (daysLeft - 1) * 86400000);
    const windowEnd   = new Date(now.getTime() +  daysLeft      * 86400000);

    const expiringUsers = await User.find({
      role: "vendor",
      "subscription.expiresAt": { $gte: windowStart, $lt: windowEnd },
    }).select("_id subscription").lean();

    for (const user of expiringUsers) {
      const planName  = user.subscription?.plan ?? "your plan";
      const dedupeKey = `expiring-${daysLeft}-${user._id}-${user.subscription.expiresAt.toDateString()}`;
      const typeMap   = { 7: "subscription_expiring_7", 3: "subscription_expiring_3", 1: "subscription_expiring_1" };
      const urgency   = daysLeft === 1 ? "Urgent: " : daysLeft === 3 ? "Warning: " : "";
      const dayLabel  = daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`;

      await Notification.findOneAndUpdate(
        { dedupeKey },
        {
          user:        user._id,
          type:        typeMap[daysLeft],
          title:       `${urgency}Subscription expiring ${dayLabel}`,
          message:     `Your ${planName} subscription expires ${dayLabel}. Renew now to keep your listings live.`,
          actionUrl:   "/subscription?renew=1",
          actionLabel: "Renew now",
          dedupeKey,
        },
        { upsert: true }
      );
    }
    console.log(`[cron] ${expiringUsers.length} vendors notified for ${daysLeft}-day expiry`);
  }

  // Downgrade expired vendors → guest
  const expiredUsers = await User.find({
    role: "vendor",
    "subscription.expiresAt": { $lt: now },
  }).select("_id subscription").lean();

  for (const user of expiredUsers) {
    const dedupeKey = `expired-${user._id}-${user.subscription.expiresAt.toDateString()}`;

    await User.findByIdAndUpdate(user._id, { role: "guest" });  // "user" is not a valid enum

    await Notification.findOneAndUpdate(
      { dedupeKey },
      {
        user:        user._id,
        type:        "subscription_expired",
        title:       "Subscription expired",
        message:     "Your subscription has expired. Your listings are paused. Renew to reactivate them.",
        actionUrl:   "/subscription?renew=1",
        actionLabel: "Renew subscription",
        dedupeKey,
      },
      { upsert: true }
    );
  }
  console.log(`[cron] ${expiredUsers.length} expired vendors downgraded to guest`);
}

// ── 3: Daily stats snapshot ───────────────────────────────────────────────
// Runs immediately after expiry check so stats reflect post-downgrade state.
// Upserted — safe to re-run if cron fires twice.
async function writeDailyStats() {
  const today = new Date().toISOString().split("T")[0];  // "2026-04-01"
  const dayStart = new Date(today + "T00:00:00.000Z");
  const dayEnd   = new Date(today + "T23:59:59.999Z");

  console.log(`[cron] Writing daily stats for ${today}…`);

  try {
    for (const country of ["Ghana", "Nigeria"]) {
      const [
        totalUsers,
        newUsers,
        totalVendors,
        totalActiveAds,
        newAds,
        revenueAgg,
        engagementAgg,
      ] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ createdAt: { $gte: dayStart, $lte: dayEnd } }),
        User.countDocuments({ role: "vendor" }),
        Ad.countDocuments({ isActive: true, "location.country": country }),
        Ad.countDocuments({ createdAt: { $gte: dayStart, $lte: dayEnd }, "location.country": country }),

        // Revenue for this country's currency
        Purchase.aggregate([
          {
            $match: {
              status:   "successful",
              currency: country === "Nigeria" ? "NGN" : "GHS",
              createdAt: { $gte: dayStart, $lte: dayEnd },
            },
          },
          { $group: { _id: "$currency", total: { $sum: "$amount" } } },
        ]),

        // Engagement: sum of views and contactClicks for this country's active ads
        Ad.aggregate([
          { $match: { isActive: true, "location.country": country } },
          {
            $group: {
              _id:           null,
              totalViews:    { $sum: "$views" },
              totalContacts: { $sum: "$contactClicks" },
            },
          },
        ]),
      ]);

      const rev         = revenueAgg[0]?.total ?? 0;
      const engagement  = engagementAgg[0] ?? { totalViews: 0, totalContacts: 0 };

      await Stats.findOneAndUpdate(
        { date: today, country },
        {
          $set: {
            totalUsers,
            newUsers,
            totalVendors,
            totalActiveAds,
            newAds,
            revenueGHS:    country === "Ghana"   ? rev : 0,
            revenueNGN:    country === "Nigeria" ? rev : 0,
            totalViews:    engagement.totalViews,
            totalContacts: engagement.totalContacts,
          },
        },
        { upsert: true }
      );
    }
    console.log("[cron] Daily stats written ✓");
  } catch (err) {
    // Stats failure must never crash the cron — expiry check is more important
    console.error("[cron] Stats write failed (non-fatal):", err.message);
  }
}

// ── 4. Clean up stale pending purchases ───────────────────────────────────
// Removes pending purchase records older than 2 hours.
// These are abandoned checkout sessions — Flutterwave never called back.
// 2 hours is generous: a real checkout takes <5 minutes; 2 h means the
// user definitely isn't coming back to complete it.
async function cleanStalePendingPurchases() {
  try {
    const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
    const result = await Purchase.deleteMany({
      status:    "pending",
      createdAt: { $lt: cutoff },
    });
    if (result.deletedCount > 0) {
      console.log(`[cron] Cleaned ${result.deletedCount} stale pending purchases`);
    }
  } catch (err) {
    console.error("[cron] Pending purchase cleanup failed:", err.message);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────
export function startSubscriptionCron() {
  // Daily 08:00 WAT — subscription expiry + stats
  cron.schedule("0 8 * * *", async () => {
    await checkExpiringSubscriptions();
    await writeDailyStats();
  }, { timezone: "Africa/Accra" });

  // Every 2 hours — clean up abandoned checkout sessions
  cron.schedule("0 */2 * * *", async () => {
    await cleanStalePendingPurchases();
  });

  console.log("[cron] Subscription expiry + stats (08:00 WAT) + pending cleanup (every 2h) scheduled");
}

export { checkExpiringSubscriptions, writeDailyStats, cleanStalePendingPurchases };