// backend/routes/admin-promotions.js
//
// Admin promotion management. Two important fixes over the previous version:
//
//   1) All status changes now use findByIdAndUpdate($set) with runValidators:false
//      so LEGACY promotions (missing required fields like userId) don't blow up
//      when admins try to work with them.
//
//   2) Emails fire automatically on the three key transitions:
//        - Payment link sent  → user gets approval email with pay CTA
//        - Marked live        → user gets "you're live" email
//        - Rejected           → user gets "sorry, needs rework" email

import express from "express";

import Promotion from "../models/promotion.js";
import { authenticate } from "../middleware/authMiddleWare.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  getOverviewStats,
  getStatusCounts,
} from "../services/promotionStats.js";
import {
  sendPromotionApprovedEmail,
  sendPromotionLiveEmail,
  sendPromotionRejectedEmail,
} from "../services/email.js";

const router = express.Router();
router.use(authenticate, requireAdmin);


// ═══════════════════════════════════════════════════════════════════════
// GET /admin/promotions
// ═══════════════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 20);
    const skip = (page - 1) * limit;

    const baseFilter = {};
    if (req.query.country) baseFilter.country = req.query.country;
    if (req.query.tier) baseFilter.tier = req.query.tier;
    if (req.query.search) {
      baseFilter.$or = [
        { businessName: { $regex: req.query.search, $options: "i" } },
        { title: { $regex: req.query.search, $options: "i" } },
        { contactName: { $regex: req.query.search, $options: "i" } },
        { contactEmail: { $regex: req.query.search, $options: "i" } },
        { paymentRef: { $regex: req.query.search, $options: "i" } },
      ];
    }

    const listFilter = { ...baseFilter };
    if (req.query.status && req.query.status !== "all") {
      listFilter.status = req.query.status;
    }

    const [promotions, total, counts] = await Promise.all([
      Promotion.find(listFilter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("userId", "username email phone profilePicture country")
        .lean(),
      Promotion.countDocuments(listFilter),
      getStatusCounts(baseFilter),
    ]);

    res.json({
      counts,
      promotions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    console.error("[admin/promotions]", err);
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// GET /admin/promotions/overview
// ═══════════════════════════════════════════════════════════════════════
router.get("/overview", async (req, res) => {
  try {
    res.json(await getOverviewStats());
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// GET /admin/promotions/:id
// ═══════════════════════════════════════════════════════════════════════
router.get("/:id", async (req, res) => {
  try {
    const promo = await Promotion.findById(req.params.id)
      .populate(
        "userId",
        "username email phone profilePicture country createdAt",
      )
      .populate("reviewedBy", "username")
      .populate("rejectedBy", "username")
      .lean();
    if (!promo) return res.status(404).json({ message: "Not found" });
    res.json({ promotion: promo });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});



// ═══════════════════════════════════════════════════════════════════════
// POST /admin/promotions
//
// Admin-only manual create. Used to backfill lost/deleted promotions,
// import legacy campaigns, or set up a promo when the client paid outside
// the app (bank transfer, direct MoMo, cash).
//
// Bypasses the normal review flow — admin sets status directly to
// whatever they need (usually "live" for reconstruction).
//
// Add this handler to routes/admin-promotions.js, right after GET /:id
// ═════
router.post("/", async (req, res) => {
  try {
    const {
      // Advertiser
      userId, // optional — omit for legacy imports without an account
      businessName,
      contactName,
      contactEmail,
      contactPhone,
      preferredContact = "email",

      // Campaign
      title,
      description,
      category,
      promotionType,
      targetRegion,
      targetAudience,
      startDate,

      // Creative
      videoUrl,
      videoName,
      coverImage,
      thumbnailUrl,
      videoDuration,

      // Package
      tier, // "starter" | "growth" | "enterprise"
      amount, // optional — resolved from tier if omitted
      currency = "GHS",
      country = "Ghana",
      days, // optional — resolved from tier if omitted
      channels, // optional — resolved from tier if omitted

      // Status + workflow
      status = "live", // admin can set anything: submitted, paid, live...
      paymentRef, // optional — from Flutterwave
      flwTxId, // optional — from Flutterwave
      paidAt, // optional — will default to now if status=paid/live
      liveAt, // optional — will default to now if status=live
      expiresAt, // optional — computed from liveAt + days if status=live
      views = 0,
      listenerReach = 0,
      engagements = 0,
    } = req.body;

    // ─── Basic validation ────────────────────────────────────────────
    const missing = [];
    if (!businessName) missing.push("businessName");
    if (!contactEmail) missing.push("contactEmail");
    if (!videoUrl) missing.push("videoUrl");
    if (!title) missing.push("title");
    if (!tier) missing.push("tier");
    if (missing.length) {
      return res.status(400).json({
        message: `Missing required: ${missing.join(", ")}`,
      });
    }

    // ─── Resolve pricing from tier ────────────────────────────────────
    // (Pull the shared pricing catalogue so amount/days/channels stay
    //  consistent with what the /promote/pricing endpoint returns.)
    const { tierFor } = await import("../config/promoPricing.js");
    const tierData = tierFor(tier, country);
    if (!tierData) {
      return res.status(400).json({ message: `Unknown tier: ${tier}` });
    }

    // ─── Build the doc ────────────────────────────────────────────────
    const now = new Date();
    const daysResolved = days ?? tierData.days;
    const amountResolved = amount ?? tierData.amount;
    const channelsResolved = channels ?? tierData.channels;

    const doc = {
      // Owner — either provided, or the admin themselves as fallback
      userId: userId || req.user._id,

      businessName,
      contactName,
      contactEmail: contactEmail.toLowerCase(),
      contactPhone,
      preferredContact,

      title,
      description,
      category,
      promotionType,
      targetRegion,
      targetAudience,
      startDate: startDate ? new Date(startDate) : undefined,

      videoUrl,
      videoName,
      coverImage,
      thumbnailUrl,
      videoDuration,

      tier,
      amount: amountResolved,
      currency,
      country,
      days: daysResolved,
      channels: channelsResolved,

      status,
      paymentRef,
      flwTxId,
      views,
      listenerReach,
      engagements,

      // Timestamp defaults based on status
      reviewedAt: [
        "under_review",
        "payment_pending",
        "paid",
        "live",
        "expired",
      ].includes(status)
        ? now
        : undefined,
      reviewedBy: [
        "under_review",
        "payment_pending",
        "paid",
        "live",
        "expired",
      ].includes(status)
        ? req.user._id
        : undefined,
      paymentLinkSentAt: [
        "payment_pending",
        "paid",
        "live",
        "expired",
      ].includes(status)
        ? paidAt
          ? new Date(paidAt)
          : now
        : undefined,
      paidAt: ["paid", "live", "expired"].includes(status)
        ? paidAt
          ? new Date(paidAt)
          : now
        : undefined,
      liveAt: ["live", "expired"].includes(status)
        ? liveAt
          ? new Date(liveAt)
          : now
        : undefined,
    };

    // Compute expiry for live status
    if (status === "live" && !expiresAt) {
      const start = doc.liveAt || now;
      doc.expiresAt = new Date(start.getTime() + daysResolved * 86400 * 1000);
    } else if (expiresAt) {
      doc.expiresAt = new Date(expiresAt);
    }

    const promotion = await new (
      await import("../models/promotion.js")
    ).default(doc).save();

    console.log(
      `[admin/promotions POST] created ${promotion._id} status=${status} by admin=${req.user._id}`,
    );
    res.status(201).json({ promotion });
  } catch (err) {
    console.error("[admin/promotions POST]", err);
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PATCH /admin/promotions/:id
// Body: { action, notes?, reason?, metrics? }
// ═══════════════════════════════════════════════════════════════════════
router.patch("/:id", async (req, res) => {
  try {
    const { action, notes, reason, metrics } = req.body;

    const allowed = [
      "start_review",
      "send_payment_link",
      "mark_live",
      "expire",
      "reject",
      "refund",
      "update_metrics",
    ];
    if (!allowed.includes(action)) {
      return res.status(400).json({ message: "Invalid action" });
    }

    // Load raw promotion (lean-ish, we don't need the doc for save())
    const promo = await Promotion.findById(req.params.id);
    if (!promo) return res.status(404).json({ message: "Promotion not found" });

    // ─── Build the $set patch instead of mutating + saving ──────────
    // (This avoids re-validating the full doc, so legacy records
    //  missing required fields don't cause validation errors.)
    const now = new Date();
    const set = {};
    let emailToSend = null;

    switch (action) {
      // ── Start review ────────────────────────────────────────────
      case "start_review":
        if (promo.status !== "submitted") {
          return res
            .status(409)
            .json({ message: `Must be "submitted", is "${promo.status}"` });
        }
        set.status = "under_review";
        set.reviewedAt = now;
        set.reviewedBy = req.user._id;
        if (notes) set.reviewNotes = notes;
        break;

      // ── Send payment link (admin approves the video) ────────────
      case "send_payment_link":
        if (!["submitted", "under_review"].includes(promo.status)) {
          return res
            .status(409)
            .json({
              message: `Cannot send payment link — status is "${promo.status}"`,
            });
        }
        set.status = "payment_pending";
        set.paymentLinkSentAt = now;
        set.reviewedBy = promo.reviewedBy || req.user._id;
        set.reviewedAt = promo.reviewedAt || now;
        if (notes) set.reviewNotes = notes;
        emailToSend = { kind: "approved", notes };
        break;

      // ── Mark live (after payment received) ──────────────────────
      case "mark_live":
        if (promo.status !== "paid") {
          return res
            .status(409)
            .json({ message: `Must be "paid", is "${promo.status}"` });
        }
        set.status = "live";
        set.liveAt = now;
        set.expiresAt = new Date(Date.now() + (promo.days || 7) * 86400 * 1000);
        emailToSend = { kind: "live" };
        break;

      // ── Expire ──────────────────────────────────────────────────
      case "expire":
        set.status = "expired";
        set.expiresAt = now;
        break;

      // ── Reject ──────────────────────────────────────────────────
      case "reject":
        set.status = "rejected";
        set.rejectedAt = now;
        set.rejectedBy = req.user._id;
        set.rejectionReason = reason || "";
        emailToSend = { kind: "rejected", reason };
        break;

      // ── Refund ──────────────────────────────────────────────────
      case "refund":
        set.status = "refunded";
        set.refundedAt = now;
        set.refundedBy = req.user._id;
        set.refundReason = reason || "";
        break;

      // ── Update metrics ──────────────────────────────────────────
      case "update_metrics":
        if (metrics?.views !== undefined) set.views = metrics.views;
        if (metrics?.listenerReach !== undefined)
          set.listenerReach = metrics.listenerReach;
        if (metrics?.engagements !== undefined)
          set.engagements = metrics.engagements;
        break;
    }

    // ─── Apply the update surgically. Skip full-doc validation. ──────
    const updated = await Promotion.findByIdAndUpdate(
      req.params.id,
      { $set: set },
      { new: true, runValidators: false },
    );

    // ─── Fire the email (async, non-blocking — failures logged) ──────
    if (emailToSend) {
      const to = updated.contactEmail;
      if (!to) {
        console.warn(
          `[admin/promotions] no contactEmail on ${updated._id} — skipping ${emailToSend.kind} email`,
        );
      } else {
        try {
          if (emailToSend.kind === "approved") {
            await sendPromotionApprovedEmail({
              to,
              promotion: updated,
              adminNotes: emailToSend.notes,
            });
          } else if (emailToSend.kind === "live") {
            await sendPromotionLiveEmail({ to, promotion: updated });
          } else if (emailToSend.kind === "rejected") {
            await sendPromotionRejectedEmail({
              to,
              promotion: updated,
              reason: emailToSend.reason,
            });
          }
        } catch (e) {
          // Never fail the admin action just because email hiccuped
          console.error(
            `[admin/promotions] email failed (${emailToSend.kind}):`,
            e.message,
          );
        }
      }
    }

    res.json({ promotion: updated, message: `Applied "${action}"` });
  } catch (err) {
    console.error("[admin/promotions PATCH]", err);
    res.status(500).json({ message: err.message });
  }
});

export default router;
