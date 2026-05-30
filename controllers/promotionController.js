// controllers/promotionController.js
// Promotional campaign submission + Flutterwave payment flow.

import Promotion from "../models/promotion.js";
import User from "../models/user.js";
import { logError } from "../lib/errorLog.js";
import {
  PROMO_TIERS,
  PROMO_TIER_NAMES,
  getPromoPrice,
  getPromoDays,
} from "../config/promoPricing.js";
import { initializeGatewayPayment } from "../lib/paymentGateway.js";
import { sendAdminDirectEmail } from "../lib/emailService.js";

// ── GET /promote/pricing ──────────────────────────────────────────────────
// Public endpoint — returns all tiers in the user's currency.
export const getPromoPricing = async (req, res) => {
  try {
    const currency = req.query.currency === "NGN" ? "NGN" : "GHS";

    const tiers = Object.entries(PROMO_TIERS).map(([id, t]) => ({
      id,
      label: t.label,
      days: t.days,
      badge: t.badge,
      price: t.prices[currency],
      currency,
      perks: t.perks,
    }));

    res.json({ tiers, currency });
  } catch (err) {
    logError("getPromoPricing", err);
    res.status(500).json({ message: "Failed to load pricing" });
  }
};

// ── POST /promote/submit ──────────────────────────────────────────────────
// Vendor submits campaign. Status starts as "pending_review" until admin OKs.
export const submitPromotion = async (req, res) => {
  try {
    const {
      title,
      description,
      category,
      promotionType,
      targetRegion,
      targetAudience,
      startDate,
      endDate,
      contactName,
      contactPhone,
      contactEmail,
      preferredContact,
      videoUrl,
      videoName,
      tier,
    } = req.body;

    if (!title || !videoUrl || !tier) {
      return res
        .status(400)
        .json({ message: "Title, video URL, and tier are required" });
    }
    if (!PROMO_TIERS[tier]) {
      return res.status(400).json({ message: "Invalid pricing tier" });
    }

    const user = await User.findById(req.user.userId).select(
      "country email username phone",
    );
    if (!user) return res.status(404).json({ message: "User not found" });

    const country = user.country === "Nigeria" ? "Nigeria" : "Ghana";
    const currency = country === "Nigeria" ? "NGN" : "GHS";
    const amount = getPromoPrice(tier, currency);
    const days = getPromoDays(tier);

    const promotion = await Promotion.create({
      user: user._id,
      title,
      description,
      category,
      promotionType,
      targetRegion,
      targetAudience,
      startDate,
      endDate,
      videoUrl,
      videoName,
      tier,
      amount,
      currency,
      days,
      country,
      contactName: contactName || user.username,
      contactPhone: contactPhone || user.phone,
      contactEmail: contactEmail || user.email,
      preferredContact: preferredContact || "email",
      status: "pending_review",
    });

    // Email admin team for review (non-blocking)
    sendAdminDirectEmail({
      to: process.env.ADMIN_EMAIL || process.env.EMAIL_USER,
      name: "SmileBaba Admin",
      subject: `[Promo Review] ${PROMO_TIER_NAMES[tier]} — ${title}`,
      message: `
New promotion submitted for review.

Vendor:    ${user.username} (${user.email})
Campaign:  ${title}
Tier:      ${PROMO_TIER_NAMES[tier]} — ${currency} ${amount}
Country:   ${country}
Region:    ${targetRegion || "Not specified"}

Description:
${description || "No description provided"}

Video: ${videoUrl}

Review and approve at:
${process.env.APP_URL ?? "https://smilebabahub.com"}/admin/promotions/${promotion._id}
      `.trim(),
    }).catch((e) => console.error("[promo email]", e.message));

    res.status(201).json({
      message:
        "Campaign submitted for review. We'll contact you within 2–3 business days.",
      promotion: {
        _id: promotion._id,
        status: promotion.status,
        tier,
        amount,
        currency,
      },
    });
  } catch (err) {
    logError("submitPromotion", err);
    res.status(500).json({ message: "Failed to submit campaign" });
  }
};

// ── GET /promote/my ───────────────────────────────────────────────────────
// Returns the logged-in user's campaigns.
export const getMyPromotions = async (req, res) => {
  try {
    const list = await Promotion.find({ user: req.user.userId })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ promotions: list });
  } catch (err) {
    logError("getMyPromotions", err);
    res.status(500).json({ message: "Failed to load campaigns" });
  }
};

// ── POST /promote/:id/pay ─────────────────────────────────────────────────
// Owner initiates Flutterwave payment after admin approves.
export const initializePromoPayment = async (req, res) => {
  try {
    const promo = await Promotion.findById(req.params.id);
    if (!promo) return res.status(404).json({ message: "Campaign not found" });

    if (String(promo.user) !== req.user.userId) {
      return res.status(403).json({ message: "Not authorized" });
    }
    if (promo.status !== "approved" && promo.status !== "pending_payment") {
      return res.status(400).json({
        message: `Cannot pay — campaign is in ${promo.status} status`,
      });
    }

    const user = await User.findById(req.user.userId)
      .select("email username phone whatsapp")
      .lean();

    const tx_ref = `promo-${promo.country.toLowerCase()}-${promo._id}-${Date.now()}`;
    const backendBase = (
      process.env.BACKEND_URL ??
      process.env.RENDER_EXTERNAL_URL ??
      `${req.protocol}://${req.get("host")}` ??
      ""
    ).replace(/\/+$/, "");
    if (!backendBase) {
      return res.status(500).json({ message: "Could not resolve backend URL" });
    }
    const verifyPath = `/smilebaba/promote/verify`;
    const redirect_url = `${backendBase}${verifyPath}?promoId=${promo._id}`;

    const payload = {
      tx_ref,
      amount: promo.amount,
      currency: promo.currency,
      redirect_url,
      meta: {
        userId: user._id.toString(),
        promoId: promo._id.toString(),
        tier: promo.tier,
        type: "promotion",
      },
      customer: {
        email: user.email,
        name: user.username || user.email?.split("@")[0] || "Customer",
        phonenumber: user.phone || user.whatsapp || "0000000000",
      },
      customizations: {
        title: "SmileBaba Promo Campaign",
        description: `${PROMO_TIER_NAMES[promo.tier]} — ${promo.title}`,
        logo: `${process.env.APP_URL ?? "https://smilebabahub.com"}/logo.png`,
        color: "#ffc105",
      },
    };

    const countryCode = promo.country === "Nigeria" ? "NG" : "GH";
    const { paymentLink } = await initializeGatewayPayment({
      countryCode,
      payload,
    });

    // Save the tx_ref + link so the verify step can match it
    promo.txRef = tx_ref;
    promo.status = "pending_payment";
    promo.paymentLink = paymentLink;
    promo.paymentLinkSent = true;
    await promo.save();

    res.json({ paymentLink, txRef: tx_ref });
  } catch (err) {
    const msg = err.response?.data?.message ?? err.message;
    logError("initializePromoPayment", msg);
    res.status(500).json({ message: msg ?? "Failed to start payment" });
  }
};

// ── GET /promote/verify ───────────────────────────────────────────────────
// Flutterwave redirects here after payment.
export const verifyPromoPayment = async (req, res) => {
  try {
    const { transaction_id, promoId, status } = req.query;
    const frontend = (
      process.env.APP_URL ?? "https://smilebabahub.com"
    ).replace(/\/+$/, "");

    if (!promoId) return res.redirect(`${frontend}/promote?error=missing_id`);

    const promo = await Promotion.findById(promoId);
    if (!promo) return res.redirect(`${frontend}/promote?error=not_found`);

    if (status !== "successful") {
      return res.redirect(
        `${frontend}/promote/status/${promoId}?status=failed`,
      );
    }

    // Verify with Flutterwave gateway
    const { verifyGatewayPayment } = await import("../lib/paymentGateway.js");
    const countryCode = promo.country === "Nigeria" ? "NG" : "GH";
    const payment = await verifyGatewayPayment({
      countryCode,
      transactionId: transaction_id,
    });

    if (payment.status !== "successful") {
      return res.redirect(
        `${frontend}/promote/status/${promoId}?status=failed`,
      );
    }

    // Accept overpayments (FLW fees), reject underpayments >5%
    const diff = payment.amount - promo.amount;
    const pctDiff = promo.amount > 0 ? Math.abs(diff) / promo.amount : 1;
    if (diff < 0 && pctDiff > 0.05) {
      return res.redirect(
        `${frontend}/promote/status/${promoId}?status=amount_mismatch`,
      );
    }

    // Activate
    promo.status = "paid";
    promo.transactionId = String(payment.id ?? transaction_id);
    promo.paidAt = new Date();
    await promo.save();

    // Notify admin
    sendAdminDirectEmail({
      to: process.env.ADMIN_EMAIL || process.env.EMAIL_USER,
      name: "SmileBaba Admin",
      subject: `[Promo Paid] ${promo.title} — ${promo.currency} ${promo.amount}`,
      message: `Promo campaign payment received. Schedule the campaign in the admin dashboard.`,
    }).catch(() => {});

    return res.redirect(`${frontend}/promote/status/${promoId}?status=paid`);
  } catch (err) {
    logError("verifyPromoPayment", err);
    const frontend = (
      process.env.APP_URL ?? "https://smilebabahub.com"
    ).replace(/\/+$/, "");
    return res.redirect(`${frontend}/promote?error=server_error`);
  }
};

// ── ADMIN: GET /admin/promotions ──────────────────────────────────────────
export const getAdminPromotions = async (req, res) => {
  try {
    const { status, tier, country, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (tier && tier !== "all") filter.tier = tier;
    if (country && country !== "all") filter.country = country;

    const lim = Math.min(Number(limit), 100);
    const skip = (Number(page) - 1) * lim;

    const [promos, total, statusCounts] = await Promise.all([
      Promotion.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(lim)
        .populate("user", "username email phone")
        .lean(),
      Promotion.countDocuments(filter),
      Promotion.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);

    const statusSummary = statusCounts.reduce((acc, s) => {
      acc[s._id] = s.count;
      return acc;
    }, {});

    res.json({
      promotions: promos,
      meta: {
        total,
        page: Number(page),
        limit: lim,
        totalPages: Math.ceil(total / lim),
      },
      statusSummary,
    });
  } catch (err) {
    logError("getAdminPromotions", err);
    res.status(500).json({ message: "Failed to load promotions" });
  }
};

// ── ADMIN: PATCH /admin/promotions/:id ────────────────────────────────────
export const updateAdminPromotion = async (req, res) => {
  try {
    const allowed = [
      "status",
      "adminNotes",
      "rejectionReason",
      "scheduledStart",
      "scheduledEnd",
    ];
    const updates = {};
    for (const k of allowed) if (k in req.body) updates[k] = req.body[k];

    const promo = await Promotion.findByIdAndUpdate(req.params.id, updates, {
      new: true,
    }).populate("user", "username email");
    if (!promo) return res.status(404).json({ message: "Not found" });

    // If approving, email the vendor with payment link
    if (updates.status === "approved") {
      sendAdminDirectEmail({
        to: promo.contactEmail || promo.user?.email,
        name: promo.contactName || promo.user?.username,
        subject: `Your SmileBaba promo "${promo.title}" is approved!`,
        message: `
Great news! Your promotional campaign has been approved.

Plan:    ${PROMO_TIER_NAMES[promo.tier]}
Amount:  ${promo.currency} ${promo.amount}

To activate your campaign, complete payment here:
${process.env.APP_URL ?? "https://smilebabahub.com"}/promote/pay/${promo._id}

Once paid, your campaign will go live within 48 hours.
        `.trim(),
      }).catch(() => {});
    }

    res.json({ promotion: promo });
  } catch (err) {
    logError("updateAdminPromotion", err);
    res.status(500).json({ message: "Failed to update" });
  }
};
