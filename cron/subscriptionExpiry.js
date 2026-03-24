// cron/subscriptionExpiry.js
// Run this file on server start — fires daily at 8am
// Install: npm i node-cron

import cron from "node-cron";
import User from "../models/user.js";
import Notification from "../models/notificationModel.js";

// Days before expiry to notify
const NOTIFY_AT_DAYS = [7, 3, 1];

async function checkExpiringSubscriptions() {
  console.log("[cron] Running subscription expiry check…");

  const now = new Date();

  for (const daysLeft of NOTIFY_AT_DAYS) {
    // Window: find subscriptions expiring within this exact day bucket
    // e.g. for daysLeft=7: expiresAt between now+6d23h and now+7d
    const windowStart = new Date(
      now.getTime() + (daysLeft - 1) * 24 * 60 * 60 * 1000,
    );
    const windowEnd = new Date(now.getTime() + daysLeft * 24 * 60 * 60 * 1000);

    const expiringUsers = await User.find({
      role: "vendor",
      "subscription.expiresAt": { $gte: windowStart, $lt: windowEnd },
    }).select("_id name subscription");

    for (const user of expiringUsers) {
      const planName = user.subscription?.plan ?? "your plan";
      const dedupeKey = `expiring-${daysLeft}-${user._id}-${user.subscription.expiresAt.toDateString()}`;

      const typeMap = {
        7: "subscription_expiring_7",
        3: "subscription_expiring_3",
        1: "subscription_expiring_1",
      };

      const urgencyEmoji = daysLeft === 1 ? "🚨" : daysLeft === 3 ? "⚠️" : "📅";
      const dayLabel = daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`;

      await Notification.findOneAndUpdate(
        { dedupeKey },
        {
          user: user._id,
          type: typeMap[daysLeft],
          title: `${urgencyEmoji} Subscription expiring ${dayLabel}`,
          message: `Your ${planName} subscription expires ${dayLabel}. Renew now to keep your listings live and avoid losing vendor access.`,
          actionUrl: "/subscribe?renew=1",
          actionLabel: "Renew now",
          dedupeKey,
        },
        { upsert: true },
      );
    }

    console.log(
      `[cron] ${expiringUsers.length} users notified for ${daysLeft}-day expiry`,
    );
  }

  // Also find already-expired vendors and downgrade them
  const expiredUsers = await User.find({
    role: "vendor",
    "subscription.expiresAt": { $lt: now },
  }).select("_id subscription");

  for (const user of expiredUsers) {
    const dedupeKey = `expired-${user._id}-${user.subscription.expiresAt.toDateString()}`;

    await User.findByIdAndUpdate(user._id, { role: "user" });

    await Notification.findOneAndUpdate(
      { dedupeKey },
      {
        user: user._id,
        type: "subscription_expired",
        title: "⛔ Subscription expired",
        message:
          "Your subscription has expired. Your listings are now paused. Renew to reactivate them.",
        actionUrl: "/subscribe?renew=1",
        actionLabel: "Renew subscription",
        dedupeKey,
      },
      { upsert: true },
    );
  }

  console.log(`[cron] ${expiredUsers.length} expired vendors downgraded`);
}

// Schedule: every day at 8:00 AM server time
export function startSubscriptionCron() {
  cron.schedule("0 8 * * *", checkExpiringSubscriptions, {
    timezone: "Africa/Accra", // GMT+0 — covers both Ghana and Nigeria
  });

  console.log("[cron] Subscription expiry checker scheduled (daily 08:00 WAT)");
}

// Also export the function for manual runs / testing
export { checkExpiringSubscriptions };
