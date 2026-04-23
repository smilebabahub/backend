// controllers/adBoostPaymentController.js
// Handles payment flow specifically for ad boosts.
// Flow:
//   1. Vendor clicks "Boost" on their ad
//   2. Frontend calls POST /payments/boost/initialize
//   3. Backend creates a pending BoostPurchase and returns Flutterwave payment link
//   4. Vendor completes payment on Flutterwave
//   5. Flutterwave redirects to /payment-success?type=boost
//   6. Backend verifies via GET /payments/boost/verify
//   7. Ad boost fields are activated
//   8. Webhook at POST /payments/boost/webhook handles server-side confirmation

import Ad from "../models/adModel.js";
import User from "../models/user.js";
import Purchase from "../models/purchaseModel.js";
import Notification from "../models/notificationModel.js";
import {
  BOOST_PRICING,
  BOOST_TIER_NAMES,
  BOOST_DURATION_DAYS,
} from "../config/boostPricing.js";
import {
  initializeGatewayPayment,
  verifyGatewayPayment,
  verifyWebhookSignature,
} from "../lib/paymentGateway.js";
import { sendBoostEmails, sendBoostReceipt } from "../lib/emailService.js";

// ── Activate boost on an ad ────────────────────────────────────────────────
async function activateAdBoost({ adId, tier, txRef, payment }) {
  const days = BOOST_DURATION_DAYS[tier] ?? 7;
  const now = new Date();
  const boostedUntil = new Date(now.getTime() + days * 86400000);

  await Ad.findByIdAndUpdate(adId, {
    "boost.isBoosted": true,
    "boost.boostedAt": now,
    "boost.boostedUntil": boostedUntil,
    "boost.boostTier": tier,
  });

  // Notify the vendor + send email
  const ad = await Ad.findById(adId)
    .select("title postedBy")
    .populate("postedBy", "email username");
  if (ad) {
    // ── Create a Purchase record so boost revenue shows in admin ─────────────
    await Purchase.findOneAndUpdate(
      { txRef },
      {
        $setOnInsert: { createdAt: now },
        $set: {
          user: ad.postedBy._id ?? ad.postedBy,
          txRef,
          type: "boost",
          transactionId: String(payment.id ?? ""),
          title: `Ad Boost — ${BOOST_TIER_NAMES[tier]} (${days}d)`,
          planId: tier,
          billingCycle: "once",
          adId: adId,
          amount: payment.amount,
          currency: payment.currency,
          status: "successful",
          periodStart: now,
          periodEnd: boostedUntil,
          gatewayMeta: payment,
        },
      },
      { upsert: true, new: true },
    );

    await Notification.findOneAndUpdate(
      { dedupeKey: `boost-${txRef}` },
      {
        user: ad.postedBy._id ?? ad.postedBy,
        type: "boost_approved",
        title: "Ad boosted successfully",
        message: `Your ad "${ad.title}" is now boosted as ${BOOST_TIER_NAMES[tier]} for ${days} days.`,
        actionUrl: `/ads/${adId}`,
        actionLabel: "View your ad",
        dedupeKey: `boost-${txRef}`,
      },
      { upsert: true },
    );

    // Fire boost email (non-blocking)
    const vendor = ad.postedBy;
    if (vendor?.email) {
      sendBoostEmails({
        username: vendor.username,
        email: vendor.email,
        adTitle: ad.title,
        adId: String(adId),
        tier,
        tierLabel: BOOST_TIER_NAMES[tier],
        days,
        amount: payment.amount,
        currency: payment.currency,
      }).catch((e) => console.error("[boost] email error:", e.message));

      // Send purchase receipt
      sendBoostReceipt({
        username: vendor.username,
        email: vendor.email,
        adTitle: ad.title,
        adId: String(adId),
        tier,
        tierLabel: BOOST_TIER_NAMES[tier],
        days,
        amount: payment.amount,
        currency: payment.currency,
        txRef: payment.tx_ref ?? payment.txRef,
      }).catch((e) => console.error("[boost] receipt error:", e.message));
    }
  }

  return { boostedUntil, days };
}

// ── INITIALIZE BOOST PAYMENT ───────────────────────────────────────────────
// POST /payments/boost/initialize
// Body: { adId, tier, returnUrl }
export const initializeBoostPayment = async (req, res) => {
  try {
    const { adId, tier, returnUrl } = req.body;
    const userId = req.user.userId;
    const countryCode = req.countryCode;
    const currency = req.gatewayCurrency;

    // Validate tier
    const tierConfig = BOOST_PRICING[tier];
    if (!tierConfig) {
      return res.status(400).json({ message: "Invalid boost tier" });
    }

    // Validate ad ownership
    const ad = await Ad.findById(adId).select("title postedBy isActive isSold");
    if (!ad) {
      return res.status(404).json({ message: "Ad not found" });
    }
    if (String(ad.postedBy) !== userId) {
      return res
        .status(403)
        .json({ message: "You can only boost your own ads" });
    }
    if (!ad.isActive || ad.isSold) {
      return res
        .status(400)
        .json({ message: "Cannot boost a sold or inactive ad" });
    }

    const user = await User.findById(userId).select("email username phone");
    if (!user) return res.status(404).json({ message: "User not found" });

    const amount = tierConfig.prices.once[currency];
    if (amount === undefined) {
      return res
        .status(400)
        .json({ message: "Unsupported currency for boost" });
    }

    const tx_ref = `smileboost-${countryCode.toLowerCase()}-${userId}-${adId}-${Date.now()}`;

    const redirect_url = `${process.env.NEXT_PUBLIC_APP_URL}/payment-success?type=boost&countryCode=${countryCode}&returnUrl=${encodeURIComponent(returnUrl || `/ads/${adId}`)}`;

    const payload = {
      tx_ref,
      amount,
      currency,
      redirect_url,
      customer: {
        email: user.email,
        name: user.username,
        phonenumber: user.phone,
      },
      meta: {
        type: "ad_boost",
        userId: String(userId),
        adId: String(adId),
        tier,
        countryCode,
        returnUrl: returnUrl || `/ads/${adId}`,
      },
      customizations: {
        title: "SmileBaba Ad Boost",
        description: `${BOOST_TIER_NAMES[tier]} — ${ad.title.slice(0, 50)}`,
        logo: `${process.env.NEXT_PUBLIC_APP_URL}/logo.png`,
      },
    };

    const { paymentLink } = await initializeGatewayPayment({
      countryCode,
      payload,
    });

    res.status(200).json({
      paymentLink,
      tx_ref,
      tier,
      tierLabel: BOOST_TIER_NAMES[tier],
      days: BOOST_DURATION_DAYS[tier],
      amount,
      currency,
    });
  } catch (error) {
    console.error("initializeBoostPayment error:", error);
    res.status(500).json({ message: "Failed to initialize boost payment" });
  }
};

// ── VERIFY BOOST PAYMENT ───────────────────────────────────────────────────
// GET /payments/boost/verify?transaction_id=&returnUrl=
export const verifyBoostPayment = async (req, res) => {
  try {
    const { transaction_id, returnUrl } = req.query;
    const countryCode = req.countryCode;

    const payment = await verifyGatewayPayment({
      countryCode,
      transactionId: transaction_id,
    });

    console.log(
      "[verifyBoostPayment] payment:",
      JSON.stringify({
        id: payment.id,
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
        meta: payment.meta,
      }),
    );

    if (payment.status !== "successful") {
      return res.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/payment-failed?reason=not_successful&type=boost`,
      );
    }

    const meta = payment.meta ?? {};
    const { adId, tier, userId } = meta;

    if (!adId || !tier) {
      console.error("[verifyBoostPayment] missing meta:", meta);
      return res.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/payment-failed?reason=missing_meta&type=boost`,
      );
    }

    const currency = payment.currency;
    const expectedAmount = BOOST_PRICING[tier]?.prices?.once?.[currency];

    const diff = Math.abs(payment.amount - expectedAmount);
    if (!expectedAmount || diff > 1) {
      console.error("[verifyBoostPayment] amount mismatch", {
        expected: expectedAmount,
        got: payment.amount,
        diff,
        tier,
      });
      return res.redirect(
        `${process.env.NEXT_PUBLIC_APP_URL}/payment-failed?reason=amount_mismatch&type=boost`,
      );
    }

    await activateAdBoost({ adId, tier, txRef: payment.tx_ref, payment });

    const destination = returnUrl
      ? decodeURIComponent(returnUrl)
      : `/ads/${adId}`;
    res.redirect(`${process.env.NEXT_PUBLIC_APP_URL}${destination}?boosted=1`);
  } catch (error) {
    console.error("verifyBoostPayment error:", error);
    res.redirect(
      `${process.env.NEXT_PUBLIC_APP_URL}/payment-failed?reason=server_error&type=boost`,
    );
  }
};

// ── BOOST WEBHOOK ──────────────────────────────────────────────────────────
export const boostPaymentWebhook = async (req, res) => {
  try {
    const countryCode = req.countryCode;
    const isValid = verifyWebhookSignature({
      countryCode,
      headers: req.headers,
      body: req.body,
    });
    if (!isValid) {
      console.warn("[boostWebhook] invalid signature");
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

      // Normalise meta — same as paymentWebhook
      const rawMeta = data.meta ?? data.payment_meta ?? data.metadata ?? {};
      const meta = Array.isArray(rawMeta)
        ? rawMeta.reduce((acc, item) => {
            acc[item.metaname] = item.metavalue;
            return acc;
          }, {})
        : rawMeta;

      const { type, adId, tier } = meta;

      // Only handle boost webhooks here — subscription webhooks use paymentWebhook
      if (type !== "ad_boost") return res.status(200).end();

      const currency = data.currency;
      const amount = data.charged_amount ?? data.amount;
      const expectedAmount = BOOST_PRICING[tier]?.prices?.once?.[currency];

      const diff = Math.abs(amount - expectedAmount);
      if (!expectedAmount || diff > 1) {
        console.error("[boostWebhook] amount mismatch", {
          expected: expectedAmount,
          got: amount,
          diff,
          tier,
          txRef: data.tx_ref,
        });
        return res.status(200).end(); // 200 to stop FLW retrying
      }

      await activateAdBoost({
        adId,
        tier,
        txRef: data.tx_ref ?? data.reference,
        payment: { ...data, amount, currency },
      });

      console.log(`[boostWebhook] boosted ad ${adId} tier ${tier}`);
    }

    res.status(200).end();
  } catch (error) {
    console.error("boostPaymentWebhook error:", error);
    res.status(200).end(); // always 200 to prevent retry loops
  }
};

// ── GET BOOST PRICING (public) ─────────────────────────────────────────────
// GET /payments/boost/pricing?currency=GHS
// Frontend calls this to show the pricing in the boost modal
export const getBoostPricing = (req, res) => {
  const currency = req.query.currency ?? "GHS";
  const sym = currency === "NGN" ? "₦" : "₵";

  const tiers = Object.entries(BOOST_PRICING).map(([id, config]) => ({
    id,
    label: config.label,
    desc: config.desc,
    days: BOOST_DURATION_DAYS[id],
    amount: config.prices.once[currency] ?? 0,
    display: `${sym}${(config.prices.once[currency] ?? 0).toLocaleString()}`,
    currency,
  }));

  res.status(200).json({ tiers });
};
