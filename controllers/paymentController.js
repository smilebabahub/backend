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

const REFERRAL_DISCOUNT = 0.2;

function applyDiscount(amount, hasReferral) {
  if (!hasReferral || amount === 0) return amount;
  return +(amount * (1 - REFERRAL_DISCOUNT)).toFixed(2);
}

async function activateSubscription({
  userId,
  planId,
  billingCycle,
  payment,
  txRef,
  marketerId,
}) {
  const now = new Date();
  const expiresAt =
    billingCycle === "monthly"
      ? new Date(new Date(now).setMonth(now.getMonth() + 1))
      : new Date(new Date(now).setFullYear(now.getFullYear() + 1));

  const title = `${PLAN_NAMES[planId] ?? planId} ${billingCycle === "monthly" ? "Monthly" : "Yearly"} Plan`;

  await User.findByIdAndUpdate(userId, {
    role: "vendor",
    subscription: {
      plan: planId,
      billingCycle,
      price: payment.amount,
      currency: payment.currency,
      startedAt: now,
      expiresAt,
      referredBy: marketerId ?? null,
    },
  });

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
      marketerId: marketerId ?? null,
    },
    { upsert: true, new: true },
  );

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

  if (marketerId) {
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
      title: "New referral commission 💰",
      message: `You earned ${payment.currency} ${commission} from a ${title} referral.`,
      actionUrl: "/marketer/dashboard",
      actionLabel: "View earnings",
    });
  }

  return expiresAt;
}

export const checkReferralCode = async (req, res) => {
  try {
    const marketer = await findMarketerByCode(req.params.code);
    if (!marketer)
      return res
        .status(404)
        .json({ valid: false, message: "Invalid referral code" });
    res
      .status(200)
      .json({
        valid: true,
        discount: REFERRAL_DISCOUNT * 100,
        marketerName: marketer.name,
      });
  } catch (error) {
    res.status(500).json({ message: "Validation failed" });
  }
};

export const initializePayment = async (req, res) => {
  try {
    const { planId, billingCycle, returnUrl, referralCode } = req.body;
    const userId = req.user.userId;
    const countryCode = req.countryCode;
    const currency = req.gatewayCurrency;

    const plan = PRICING[planId];
    if (!plan)
      return res.status(400).json({ message: "Invalid plan selected" });
    const cycle = plan[billingCycle];
    if (!cycle)
      return res.status(400).json({ message: "Invalid billing cycle" });
    const baseAmount = cycle[currency];
    if (baseAmount === undefined)
      return res.status(400).json({ message: "Unsupported currency" });

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

    if (finalAmount === 0) {
      const txRef = `free-${userId}-${Date.now()}`;
      await activateSubscription({
        userId,
        planId,
        billingCycle,
        payment: { id: "free", amount: 0, currency },
        txRef,
        marketerId,
      });
      return res
        .status(200)
        .json({ free: true, redirectUrl: returnUrl || "/vendor/dashboard" });
    }

    const existingUser = await User.findById(userId);
    if (!existingUser)
      return res.status(404).json({ message: "User not found" });

    const tx_ref = `smilebaba-${countryCode.toLowerCase()}-${userId}-${Date.now()}`;
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
        email: existingUser.email,
        name: existingUser.username,
        phonenumber: existingUser.phone,
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
    res
      .status(200)
      .json({
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

export const verifyPayment = async (req, res) => {
  try {
    const { transaction_id, returnUrl } = req.query;
    const countryCode = req.countryCode;
    const payment = await verifyGatewayPayment({
      countryCode,
      transactionId: transaction_id,
    });
    if (payment.status !== "successful")
      return res.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/payment-failed?reason=not_successful`,
      );

    const { userId, planId, billingCycle, marketerId } = payment.meta;
    const baseAmount = PRICING[planId]?.[billingCycle]?.[payment.currency];
    const expectedAmount = marketerId
      ? applyDiscount(baseAmount, true)
      : baseAmount;
    if (payment.amount !== expectedAmount)
      return res.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/payment-failed?reason=amount_mismatch`,
      );

    await activateSubscription({
      userId,
      planId,
      billingCycle,
      payment,
      txRef: payment.tx_ref,
      marketerId: marketerId || null,
    });
    const destination = returnUrl
      ? decodeURIComponent(returnUrl)
      : "/vendor/dashboard";
    res.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}${destination}?subscribed=1`,
    );
  } catch (error) {
    res.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/payment-failed?reason=server_error`,
    );
  }
};

export const paymentWebhook = async (req, res) => {
  try {
    const countryCode = req.countryCode;
    const isValid = await verifyWebhookSignature({
      countryCode,
      headers: req.headers,
      body: req.body,
    });
    if (!isValid) return res.status(401).end();
    const payload = req.body;
    const isCompleted =
      payload.event === "charge.completed" ||
      payload.event === "charge.success";
    const isSuccessful =
      payload.data?.status === "successful" ||
      payload.data?.status === "success";
    if (isCompleted && isSuccessful) {
      const payment = payload.data;
      const { userId, planId, billingCycle, marketerId } =
        payment.meta ?? payment.metadata ?? {};
      const amount =
        payment.currency === "NGN" && payment.amount > 10000
          ? payment.amount / 100
          : payment.amount;
      const base = PRICING[planId]?.[billingCycle]?.[payment.currency];
      if (amount !== (marketerId ? applyDiscount(base, true) : base))
        return res.status(400).end();
      await activateSubscription({
        userId,
        planId,
        billingCycle,
        payment: { ...payment, amount },
        txRef: payment.tx_ref ?? payment.reference,
        marketerId: marketerId || null,
      });
    }
    res.status(200).end();
  } catch (error) {
    res.status(500).end();
  }
};

export const getPurchaseHistory = async (req, res) => {
  try {
    const purchases = await Purchase.find({
      user: req.user.userId,
      status: "successful",
    })
      .sort({ createdAt: -1 })
      .select(
        "title planId billingCycle amount currency periodStart periodEnd createdAt txRef",
      );
    res.status(200).json({ purchases });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch purchase history" });
  }
};

export const getNotifications = async (req, res) => {
  try {
    const userId = req.user.userId;
    const [notifications, unreadCount] = await Promise.all([
      Notification.find({ user: userId }).sort({ createdAt: -1 }).limit(20),
      Notification.countDocuments({ user: userId, isRead: false }),
    ]);
    res.status(200).json({ notifications, unreadCount });
  } catch (error) {
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
  } catch (error) {
    res.status(500).json({ message: "Failed to mark notifications" });
  }
};
