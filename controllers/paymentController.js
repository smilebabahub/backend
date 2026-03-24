import axios from "axios";
import User from "../models/user.js";
import Purchase from "../models/purchaseModel.js";
import Notification from "../models/notificationModel.js";
import { PRICING, PLAN_NAMES } from "../config/pricing.js";

// ── Shared helper: activate subscription + record purchase + notify ─────────
async function activateSubscription({
  userId,
  planId,
  billingCycle,
  payment,
  txRef,
}) {
  const now = new Date();

  const expiresAt =
    billingCycle === "monthly"
      ? new Date(new Date(now).setMonth(now.getMonth() + 1))
      : new Date(new Date(now).setFullYear(now.getFullYear() + 1));

  const planName = PLAN_NAMES[planId] ?? planId;
  const cycleLabel = billingCycle === "monthly" ? "Monthly" : "Yearly";
  const title = `${planName} ${cycleLabel} Plan`;

  // 1. Update user role + subscription
  await User.findByIdAndUpdate(userId, {
    role: "vendor",
    subscription: {
      plan: planId,
      billingCycle,
      price: payment.amount,
      currency: payment.currency,
      startedAt: now,
      expiresAt,
    },
  });

  // 2. Record purchase history
  await Purchase.findOneAndUpdate(
    { txRef },
    {
      user: userId,
      txRef,
      transactionId: String(payment.id ?? ""),
      title,
      planId,
      billingCycle,
      amount: payment.amount,
      currency: payment.currency,
      status: "successful",
      periodStart: now,
      periodEnd: expiresAt,
      gatewayMeta: payment,
    },
    { upsert: true, new: true },
  );

  // 3. Fire activation notification (dedupe by txRef)
  await Notification.findOneAndUpdate(
    { dedupeKey: `activated-${txRef}` },
    {
      user: userId,
      type: "subscription_activated",
      title: "Subscription activated 🎉",
      message: `Your ${title} is now active. You can post listings and boost products.`,
      actionUrl: "/vendor/dashboard",
      actionLabel: "Go to dashboard",
      dedupeKey: `activated-${txRef}`,
    },
    { upsert: true },
  );

  return expiresAt;
}

// ── INITIALIZE PAYMENT ─────────────────────────────────────────────────────
export const initializePayment = async (req, res) => {
  try {
    const { planId, billingCycle, currency = "GHS", returnUrl } = req.body;
    const userId = req.user.userId;

    // Validate plan + cycle + currency
    const plan = PRICING[planId];
    if (!plan)
      return res.status(400).json({ message: "Invalid plan selected" });

    const cycle = plan[billingCycle];
    if (!cycle)
      return res.status(400).json({ message: "Invalid billing cycle" });

    const amount = cycle[currency];
    if (amount === undefined)
      return res.status(400).json({ message: "Unsupported currency" });

    // Free plan — skip payment gateway
    if (amount === 0) {
      await activateSubscription({
        userId,
        planId,
        billingCycle,
        payment: { id: "free", amount: 0, currency },
        txRef: `free-${userId}-${Date.now()}`,
      });
      return res
        .status(200)
        .json({ free: true, redirectUrl: returnUrl || "/vendor/dashboard" });
    }

    const existingUser = await User.findById(userId);
    if (!existingUser)
      return res.status(404).json({ message: "User not found" });

    const tx_ref = `smilebaba-${userId}-${Date.now()}`;

    // Persist a pending purchase record immediately (for audit trail)
    await Purchase.create({
      user: userId,
      txRef: tx_ref,
      title: `${PLAN_NAMES[planId] ?? planId} ${billingCycle}`,
      planId,
      billingCycle,
      amount,
      currency,
      status: "pending",
    });

    // Build redirect URL — encode returnUrl so we resume correctly
    const encodedReturn = encodeURIComponent(returnUrl || "/vendor/dashboard");
    const redirect_url = `${process.env.NEXT_PUBLIC_APP_URL}/payment-success?returnUrl=${encodedReturn}`;

    const response = await axios.post(
      "https://api.flutterwave.com/v3/payments",
      {
        tx_ref,
        amount,
        currency,
        redirect_url,
        customer: {
          email: existingUser.email,
          name: existingUser.name,
          phonenumber: existingUser.phone,
        },
        meta: { userId, planId, billingCycle, returnUrl },
        customizations: {
          title: "SmileBaba Subscription",
          description: `${PLAN_NAMES[planId] ?? planId} ${billingCycle} subscription`,
          logo: `${process.env.NEXT_PUBLIC_APP_URL}/logo.png`,
        },
      },
      { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } },
    );

    res.status(200).json({ paymentLink: response.data.data.link });
  } catch (error) {
    console.error(
      "initializePayment error:",
      error.response?.data || error.message,
    );
    res.status(500).json({ message: "Payment initialization failed" });
  }
};

// ── VERIFY PAYMENT (redirect callback) ────────────────────────────────────
export const verifyPayment = async (req, res) => {
  try {
    const { transaction_id, returnUrl } = req.query;

    const response = await axios.get(
      `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
      { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } },
    );

    const payment = response.data.data;

    if (payment.status !== "successful") {
      return res.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/payment-failed?reason=not_successful`,
      );
    }

    const { userId, planId, billingCycle } = payment.meta;
    const tx_ref = payment.tx_ref;

    // Anti-fraud: amount must match expected
    const expectedAmount = PRICING[planId][billingCycle][payment.currency];
    if (payment.amount !== expectedAmount) {
      console.error("Amount mismatch!", {
        expected: expectedAmount,
        got: payment.amount,
      });
      return res.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/payment-failed?reason=amount_mismatch`,
      );
    }

    await activateSubscription({
      userId,
      planId,
      billingCycle,
      payment,
      txRef: tx_ref,
    });

    // Decode and resume the user's original destination
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

// ── WEBHOOK (production — idempotent) ─────────────────────────────────────
export const flutterwaveWebhook = async (req, res) => {
  try {
    const secretHash = process.env.FLW_WEBHOOK_SECRET;
    const signature = req.headers["verif-hash"];

    if (!signature || signature !== secretHash) return res.status(401).end();

    const payload = req.body;

    if (
      payload.event === "charge.completed" &&
      payload.data.status === "successful"
    ) {
      const payment = payload.data;
      const { userId, planId, billingCycle } = payment.meta;

      const expectedAmount =
        PRICING[planId]?.[billingCycle]?.[payment.currency];
      if (payment.amount !== expectedAmount) return res.status(400).end();

      // Idempotent — activateSubscription uses upsert internally
      await activateSubscription({
        userId,
        planId,
        billingCycle,
        payment,
        txRef: payment.tx_ref,
      });
    }

    res.status(200).end();
  } catch (error) {
    console.error("webhook error:", error);
    res.status(500).end();
  }
};

// ── PURCHASE HISTORY ───────────────────────────────────────────────────────
export const getPurchaseHistory = async (req, res) => {
  try {
    const userId = req.user.userId;
    const purchases = await Purchase.find({
      user: userId,
      status: "successful",
    })
      .sort({ createdAt: -1 })
      .select(
        "title planId billingCycle amount currency periodStart periodEnd createdAt txRef",
      );

    res.status(200).json({ purchases });
  } catch (error) {
    console.error("getPurchaseHistory error:", error);
    res.status(500).json({ message: "Failed to fetch purchase history" });
  }
};

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────
export const getNotifications = async (req, res) => {
  try {
    const userId = req.user.userId;
    const notifications = await Notification.find({ user: userId })
      .sort({ createdAt: -1 })
      .limit(20);

    const unreadCount = await Notification.countDocuments({
      user: userId,
      isRead: false,
    });

    res.status(200).json({ notifications, unreadCount });
  } catch (error) {
    console.error("getNotifications error:", error);
    res.status(500).json({ message: "Failed to fetch notifications" });
  }
};

export const markNotificationsRead = async (req, res) => {
  try {
    const userId = req.user.userId;
    await Notification.updateMany(
      { user: userId, isRead: false },
      { isRead: true },
    );
    res.status(200).json({ message: "All notifications marked as read" });
  } catch (error) {
    res.status(500).json({ message: "Failed to mark notifications" });
  }
};
