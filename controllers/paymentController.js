import User from "../models/user.js";
import Marketer from "../models/marketerModel.js";
import Purchase from "../models/purchaseModel.js";
import Notification from "../models/notificationModel.js";
import { PRICING, PLAN_NAMES } from "../config/pricing.js";
import { findMarketerByCode } from "./marketerController.js";
import {
  initializeGatewayPayment,
  verifyGatewayPayment,
  verifyWebhookSignature,
} from "../lib/paymentGateway.js";
import { publish, CHANNELS } from "../lib/redis.js";
import { sendSubscriptionEmails } from "../lib/emailService.js";
import { pushToUser } from "../lib/socketHandler.js";


const REFERRAL_DISCOUNT = 0.15;

// Plan tier order — higher index = higher plan
const PLAN_TIERS = ["Basic", "standard", "popular", "premium"];

function planTier(planId) {
  return PLAN_TIERS.indexOf(planId ?? "Basic");
}

function applyDiscount(amount, hasReferral) {
  if (!hasReferral || amount === 0) return amount;
  return +(amount * (1 - REFERRAL_DISCOUNT)).toFixed(2);
}

// ── Idempotent subscription activation ───────────────────────────────────────
// Uses upsert on txRef so double-calls (verify + webhook) never create duplicates.
async function activateSubscription({
  userId,
  planId,
  billingCycle,
  payment,
  txRef,
  marketerId,
}) {
  // Check if this txRef was already processed (idempotency guard)
  const existing = await Purchase.findOne({
    txRef,
    status: "successful",
  }).lean();
  if (existing) {
    console.log(
      `[activateSubscription] txRef ${txRef} already processed — skipping`,
    );
    return existing.periodEnd;
  }

  const now = new Date();
  const expiresAt =
    billingCycle === "monthly"
      ? new Date(new Date(now).setMonth(now.getMonth() + 1))
      : new Date(new Date(now).setFullYear(now.getFullYear() + 1));

  const title = `${PLAN_NAMES[planId] ?? planId} ${
    billingCycle === "monthly" ? "Monthly" : "Yearly"
  } Plan`;

  // Update subscription — preserve admin role if already set
  await User.findByIdAndUpdate(userId, [
    {
      $set: {
        role: {
          $cond: [{ $eq: ["$role", "admin"] }, "admin", "vendor"],
        },
        isSubscribed: true,
        subscription: {
          plan: planId,
          billingCycle,
          price: payment.amount,
          currency: payment.currency,
          startedAt: now,
          expiresAt,
          referredBy: marketerId ?? null,
          status: "active",
        },
      },
    },
  ]);

  // Upsert on txRef — safe to call twice (verify + webhook)
  await Purchase.findOneAndUpdate(
    { txRef },
    {
      $setOnInsert: { createdAt: now },
      $set: {
        user: userId,
        txRef,
        type: "subscription",
        transactionId: String(payment.id ?? ""),
        title,
        planId,
        billingCycle,
        amount: payment.amount,
        currency: payment.currency,
        status: "successful",
        periodStart: now,
        periodEnd: expiresAt,
        marketerId: marketerId ?? null,
        gatewayMeta: payment,
      },
    },
    { upsert: true, new: true },
  );

  // Notification (deduped by key)
  await Notification.findOneAndUpdate(
    { dedupeKey: `activated-${txRef}` },
    {
      user: userId,
      type: "subscription_activated",
      title: "Subscription activated",
      message: `Your ${title} is now active. Post listings and boost products.`,
      actionUrl: "/vendor/dashboard",
      actionLabel: "Go to dashboard",
      dedupeKey: `activated-${txRef}`,
    },
    { upsert: true },
  );

  // Push real-time notification to user's bell (if they're online)
  pushToUser(userId, "new_notification", {});

  // Marketer commission — only on first activation (idempotency: check paidOut field)
  if (marketerId) {
    const alreadyCommissioned = await Purchase.findOne({
      txRef,
      "commissions.txRef": txRef,
    }).lean();

    if (!alreadyCommissioned) {
      const originalPrice = PRICING[planId][billingCycle][payment.currency];
      const commission = +(originalPrice * REFERRAL_DISCOUNT).toFixed(2);
      const earningsField =
        payment.currency === "NGN" ? "totalEarningsNGN" : "totalEarningsGHS";
      const pendingField =
        payment.currency === "NGN" ? "pendingPayoutNGN" : "pendingPayoutGHS";

      await Marketer.findByIdAndUpdate(marketerId, {
        $inc: {
          totalReferrals: 1,
          activeReferrals: 1,
          [earningsField]: commission,
          [pendingField]: commission,
        },
        $push: {
          commissions: {
            vendor: userId,
            planId,
            billingCycle,
            originalAmount: originalPrice,
            discountAmount: payment.amount,
            commission,
            currency: payment.currency,
            txRef,
            paidOut: false,
          },
        },
      });

      await publish(CHANNELS.statsUpdate, { marketerId: String(marketerId) });
      await Notification.create({
        user: marketerId,
        type: "boost_approved",
        title: "New referral commission",
        message: `You earned ${payment.currency} ${commission} from a ${title} referral.`,
        actionUrl: "/marketer/dashboard",
        actionLabel: "View earnings",
      });
    }
  }

  return expiresAt;
}

// Fire subscription emails (non-blocking)
async function sendSubEmailsForUser({
  userId,
  planId,
  billingCycle,
  payment,
  expiresAt,
}) {
  try {
    const user = await User.findById(userId).select("email username").lean();
    if (!user) return;
    const title = `${PLAN_NAMES[planId] ?? planId} ${
      billingCycle === "monthly" ? "Monthly" : "Yearly"
    } Plan`;
    await sendSubscriptionEmails({
      username: user.username,
      email: user.email,
      planTitle: title,
      billingCycle,
      amount: payment.amount,
      currency: payment.currency,
      expiresAt,
    });
  } catch (e) {
    console.error("[paymentController] subscription email error:", e.message);
  }
}

// ── CHECK REFERRAL CODE ───────────────────────────────────────────────────────
export const checkReferralCode = async (req, res) => {
  try {
    const marketer = await findMarketerByCode(req.params.code);
    if (!marketer) {
      return res
        .status(404)
        .json({ valid: false, message: "Invalid referral code" });
    }
    res.status(200).json({
      valid: true,
      discount: REFERRAL_DISCOUNT * 100,
      marketerName: marketer.name,
    });
  } catch {
    res.status(500).json({ message: "Validation failed" });
  }
};

// ── INITIALIZE PAYMENT ────────────────────────────────────────────────────────
export const initializePayment = async (req, res) => {
  try {
    const { planId, billingCycle, returnUrl, referralCode } = req.body;
    const userId = req.user.userId;
    const countryCode = req.countryCode;
    const currency = req.gatewayCurrency;

    // ── Validate plan exists ──────────────────────────────────────────────────
    const plan = PRICING[planId];
    if (!plan)
      return res.status(400).json({ message: "Invalid plan selected" });
    const cycle = plan[billingCycle];
    if (!cycle)
      return res.status(400).json({ message: "Invalid billing cycle" });
    const baseAmount = cycle[currency];
    if (baseAmount === undefined) {
      return res.status(400).json({ message: "Unsupported currency" });
    }

    // ── Subscription guard: check current plan ────────────────────────────────
    const user = await User.findById(userId)
      .select("subscription role email username phone")
      .lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    const currentPlanId = user.subscription?.plan;
    const currentBillingCycle = user.subscription?.billingCycle;
    const subscriptionActive =
      user.subscription?.expiresAt &&
      new Date(user.subscription.expiresAt) > new Date();

    if (subscriptionActive && currentPlanId) {
      const currentTier = planTier(currentPlanId);
      const requestedTier = planTier(planId);

      // Same plan, same billing — block duplicate
      if (currentPlanId === planId && currentBillingCycle === billingCycle) {
        return res.status(409).json({
          message: "You are already on this plan.",
          code: "SAME_PLAN",
          currentPlan: currentPlanId,
        });
      }

      // Same plan, different billing — allow (it's a billing-cycle change)
      // Lower plan — block downgrade (must expire first or contact support)
      if (requestedTier < currentTier && planId !== "Basic") {
        return res.status(409).json({
          message: `You are currently on a higher plan (${PLAN_NAMES[currentPlanId]}). Downgrades take effect at renewal. Contact support to arrange a downgrade.`,
          code: "DOWNGRADE_NOT_ALLOWED",
          currentPlan: currentPlanId,
        });
      }

      // Free plan re-selection while already on free — block
      if (planId === "Basic" && currentPlanId === "Basic") {
        return res.status(409).json({
          message:
            "You are already on the free plan. Choose a paid plan to unlock more features.",
          code: "ALREADY_FREE",
          currentPlan: "Basic",
        });
      }
    }

    // ── Referral code ─────────────────────────────────────────────────────────
    let marketerId = null,
      finalAmount = baseAmount,
      discountApplied = false;
    if (referralCode?.trim()) {
      const marketer = await findMarketerByCode(referralCode.trim());
      if (marketer) {
        marketerId = marketer._id;
        finalAmount = applyDiscount(baseAmount, true);
        discountApplied = true;
      }
    }

    // ── Free plan activation ──────────────────────────────────────────────────
    if (finalAmount === 0) {
      // Double-check: user shouldn't be able to activate free if already active
      if (subscriptionActive && currentPlanId === "Basic") {
        return res.status(409).json({
          message: "You already have an active free plan.",
          code: "ALREADY_FREE",
        });
      }
      const txRef = `free-${userId}-${Date.now()}`;
      const expiresAt = await activateSubscription({
        userId,
        planId,
        billingCycle,
        payment: { id: "free", amount: 0, currency },
        txRef,
        marketerId,
      });
      sendSubEmailsForUser({
        userId,
        planId,
        billingCycle,
        payment: { amount: 0, currency },
        expiresAt,
      }).catch(() => {});
      return res
        .status(200)
        .json({ free: true, redirectUrl: returnUrl || "/vendor/dashboard" });
    }

    // ── Paid plan: create pending purchase + Flutterwave link ─────────────────
    const tx_ref = `smilebaba-${countryCode.toLowerCase()}-${userId}-${Date.now()}`;

    // Clean up any stale pending purchases for same user+plan (prevents duplicate rows)
    await Purchase.deleteMany({
      user: userId,
      status: "pending",
      planId,
      billingCycle,
    });

    await Purchase.create({
      user: userId,
      txRef: tx_ref,
      title: `${PLAN_NAMES[planId] ?? planId} ${billingCycle}`,
      planId,
      billingCycle,
      amount: finalAmount,
      currency,
      status: "pending",
      marketerId: marketerId ?? null,
    });

    const redirect_url = `${process.env.NEXT_PUBLIC_APP_URL}/payment-success?countryCode=${countryCode}&returnUrl=${encodeURIComponent(returnUrl || "/vendor/dashboard")}`;

    const payload = {
      tx_ref,
      amount: finalAmount,
      currency,
      redirect_url,
      customer: {
        email: user.email,
        name: user.username,
        phonenumber: user.phone,
      },
      meta: {
        userId,
        planId,
        billingCycle,
        returnUrl,
        countryCode,
        marketerId: String(marketerId ?? ""),
      },
      customizations: {
        title: "SmileBaba Subscription",
        description: `${PLAN_NAMES[planId] ?? planId} ${billingCycle}${discountApplied ? " (20% referral discount)" : ""}`,
        logo: `${process.env.NEXT_PUBLIC_APP_URL}/logo.png`,
      },
    };

    const { paymentLink } = await initializeGatewayPayment({
      countryCode,
      payload,
    });

    res.status(200).json({
      paymentLink,
      countryCode,
      currency,
      originalAmount: baseAmount,
      finalAmount,
      discountApplied,
      discountPercent: discountApplied ? 20 : 0,
    });
  } catch (error) {
    console.error(
      "initializePayment error:",
      error.response?.data || error.message,
    );
    res.status(500).json({ message: "Payment initialization failed" });
  }
};

// ── VERIFY PAYMENT (Flutterwave redirect) ─────────────────────────────────────
export const verifyPayment = async (req, res) => {
  try {
    const { transaction_id, returnUrl } = req.query;
    const countryCode = req.countryCode;
    const payment = await verifyGatewayPayment({
      countryCode,
      transactionId: transaction_id,
    });

    console.log(
      "[verifyPayment] payment object:",
      JSON.stringify({
        id: payment.id,
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
        tx_ref: payment.tx_ref,
        meta: payment.meta,
      }),
    );

    if (payment.status !== "successful") {
      console.warn("[verifyPayment] not successful:", payment.status);
      return res.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/payment-failed?reason=not_successful`,
      );
    }

    // Meta can be at payment.meta (normalised) or nested variants
    const meta = payment.meta ?? payment.metadata ?? {};
    const { userId, planId, billingCycle, marketerId } = meta;

    if (!userId || !planId || !billingCycle) {
      console.error("[verifyPayment] missing meta fields:", {
        userId,
        planId,
        billingCycle,
      });
      return res.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/payment-failed?reason=missing_meta`,
      );
    }

    const baseAmount = PRICING[planId]?.[billingCycle]?.[payment.currency];
    const expectedAmount = marketerId
      ? applyDiscount(baseAmount, true)
      : baseAmount;

    // Tolerance check — allow ±1 unit to cover floating-point and rounding
    // differences between Flutterwave charged_amount and our calculated price
    const diff = Math.abs(payment.amount - expectedAmount);
    if (diff > 1) {
      console.error("[verifyPayment] amount mismatch", {
        paid: payment.amount,
        expected: expectedAmount,
        diff,
        planId,
        billingCycle,
      });
      return res.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/payment-failed?reason=amount_mismatch`,
      );
    }

    const expiresAt = await activateSubscription({
      userId,
      planId,
      billingCycle,
      payment,
      txRef: payment.tx_ref,
      marketerId: marketerId || null,
    });

    sendSubEmailsForUser({
      userId,
      planId,
      billingCycle,
      payment,
      expiresAt,
    }).catch(() => {});

    const destination = returnUrl
      ? decodeURIComponent(returnUrl)
      : "/vendor/dashboard";
    res.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}${destination}?subscribed=1`,
    );
  } catch (error) {
    console.error("verifyPayment error:", error);
    res.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/payment-failed?reason=server_error`,
    );
  }
};

// ── WEBHOOK (Flutterwave server-side confirmation) ────────────────────────────
export const paymentWebhook = async (req, res) => {
  try {
    const countryCode = req.countryCode;
    const isValid = verifyWebhookSignature({
      countryCode,
      headers: req.headers,
      body: req.body,
    });
    if (!isValid) {
      console.warn("[paymentWebhook] invalid signature");
      return res.status(401).end();
    }

    const payload = req.body;
    const isCompleted =
      payload.event === "charge.completed" ||
      payload.event === "charge.success";
    const isSuccessful =
      payload.data?.status === "successful" ||
      payload.data?.status === "success";

    if (isCompleted && isSuccessful) {
      const data = payload.data;

      // Normalise meta — FLW webhooks use the same shape as verify but
      // meta can be an array of { metaname, metavalue } or a plain object
      const rawMeta = data.meta ?? data.payment_meta ?? data.metadata ?? {};
      const meta = Array.isArray(rawMeta)
        ? rawMeta.reduce((acc, item) => {
            acc[item.metaname] = item.metavalue;
            return acc;
          }, {})
        : rawMeta;

      const { userId, planId, billingCycle, marketerId } = meta;

      if (!userId || !planId || !billingCycle) {
        console.error("[paymentWebhook] missing meta:", {
          userId,
          planId,
          billingCycle,
          meta,
        });
        return res.status(200).end(); // return 200 so FLW doesn't retry
      }

      // Use charged_amount (actual settlement) — some FLW versions differ from amount
      const amount = data.charged_amount ?? data.amount;

      const base = PRICING[planId]?.[billingCycle]?.[data.currency];
      const expected = marketerId ? applyDiscount(base, true) : base;

      const diff = Math.abs(amount - expected);
      if (diff > 1) {
        console.error("[paymentWebhook] amount mismatch", {
          paid: amount,
          expected,
          diff,
          planId,
          billingCycle,
          txRef: data.tx_ref,
        });
        return res.status(200).end(); // return 200 — don't let FLW retry forever
      }

      const expiresAt = await activateSubscription({
        userId,
        planId,
        billingCycle,
        payment: { ...data, amount, currency: data.currency },
        txRef: data.tx_ref ?? data.reference,
        marketerId: marketerId || null,
      });

      sendSubEmailsForUser({
        userId,
        planId,
        billingCycle,
        payment: { ...data, amount, currency: data.currency },
        expiresAt,
      }).catch(() => {});

      console.log(
        `[paymentWebhook] activated ${planId}/${billingCycle} for user ${userId}`,
      );
    }

    res.status(200).end();
  } catch (error) {
    console.error("paymentWebhook error:", error);
    res.status(200).end(); // always 200 to prevent FLW retry loops
  }
};

// ── PURCHASE HISTORY ──────────────────────────────────────────────────────────
export const getPurchaseHistory = async (req, res) => {
  try {
    const userId = req.user.userId;

    const [purchases, user] = await Promise.all([
      Purchase.find({
        user: userId,
        status: "successful",
      })
        .sort({ createdAt: -1 })
        .select(
          "title planId billingCycle type amount currency periodStart periodEnd createdAt txRef adId",
        )
        .lean(),
      User.findById(userId).select("subscription role").lean(),
    ]);

    // Deduplicate by txRef
    const seen = new Set();
    const deduped = purchases.filter((p) => {
      if (seen.has(p.txRef)) return false;
      seen.add(p.txRef);
      return true;
    });

    // If vendor has an active subscription but no Purchase record yet
    // (e.g. admin-granted subscription), synthesise a record so the
    // history page is never empty for an active vendor
    const hasPurchaseRecord = deduped.some(
      (p) => p.type === "subscription" || p.planId === user?.subscription?.plan,
    );

    // Include admin users who have an active subscription (site owners who are also vendors)
    const hasActiveSubscription =
      user?.subscription?.plan &&
      user.subscription.plan !== "Basic" &&
      user.subscription.expiresAt &&
      new Date(user.subscription.expiresAt) > new Date();

    if (!hasPurchaseRecord && hasActiveSubscription) {
      deduped.unshift({
        _id: "synth-active",
        title: `${user.subscription.plan} Plan (active)`,
        planId: user.subscription.plan,
        billingCycle: user.subscription.billingCycle ?? "monthly",
        type: "subscription",
        amount: user.subscription.price ?? 0,
        currency: user.subscription.currency ?? "GHS",
        periodStart: user.subscription.startedAt,
        periodEnd: user.subscription.expiresAt,
        createdAt: user.subscription.startedAt,
        txRef: "synth-active",
        adId: null,
      });
    }

    res.status(200).json({
      purchases: deduped,
      // Current active subscription — used by the history page header
      activePlan: user?.subscription ?? null,
    });
  } catch (error) {
    console.error("getPurchaseHistory error:", error);
    res.status(500).json({ message: "Failed to fetch purchase history" });
  }
};

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
export const getNotifications = async (req, res) => {
  try {
    const userId = req.user.userId;
    const [notifications, unreadCount] = await Promise.all([
      Notification.find({ user: userId }).sort({ createdAt: -1 }).limit(20),
      Notification.countDocuments({ user: userId, isRead: false }),
    ]);
    res.status(200).json({ notifications, unreadCount });
  } catch {
    res.status(500).json({ message: "Failed to fetch notifications" });
  }
};

export const markNotificationsRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { user: req.user.userId, isRead: false },
      { isRead: true },
    );
    res.status(200).json({ message: "All notifications marked as read" });
  } catch {
    res.status(500).json({ message: "Failed to mark notifications" });
  }
};