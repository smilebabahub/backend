// backend/routes/admin-promotions.js
//
// ═══════════════════════════════════════════════════════════════════════
// CANONICAL VERSION — read the header before changing anything
// ═══════════════════════════════════════════════════════════════════════
//
// AUTH CONTRACT (established by controllers/authController.js):
//   - Your JWT payload contains `userId` (see generateAccessToken)
//   - `authenticate` middleware puts that payload on `req.user`
//   - Therefore the admin's id at request time is → req.user.userId
//   - NOT req.user._id, NOT req.user.id
//
// If auth is ever refactored, update the resolveAdminId() helper below.
// Every other file in the codebase that mutates on behalf of an admin
// should follow the same pattern.

import express from "express";
import Promotion from "../models/promotion.js";
import { authenticate } from "../middleware/authMiddleWare.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { tierFor } from "../config/promoPricing.js";
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

// ─── Single source of truth for resolving the admin's user id ──────
// Reads `req.user.userId` (your JWT shape). Falls back through common
// alternatives just in case some route in your codebase uses a
// different auth middleware. Returns null if none resolve.
function resolveAdminId(req) {
  return (
    req.user?.userId ??
    req.user?._id ??
    req.user?.id ??
    req.auth?.userId ??
    null
  );
}

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
    console.error("[admin/promotions GET]", err);
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// GET /admin/promotions/overview
// ═══════════════════════════════════════════════════════════════════════
router.get("/overview", async (_req, res) => {
  try {
    res.json(await getOverviewStats());
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
// ═══════════════════════════════════════════════════════════════════════
router.post("/", async (req, res) => {
  try {
    const adminId = resolveAdminId(req);
    if (!adminId) {
      console.error(
        "[admin/promotions POST] cannot resolve admin id. req.user =",
        req.user,
      );
      return res.status(401).json({ message: "Not authenticated" });
    }

    const {
      userId, // optional — link to existing user; falls back to adminId
      businessName,
      contactName,
      contactEmail,
      contactPhone,
      preferredContact = "email",
      title,
      description,
      category,
      promotionType,
      targetRegion,
      targetAudience,
      startDate,
      videoUrl,
      videoName,
      coverImage,
      thumbnailUrl,
      videoDuration,
      tier,
      amount,
      currency = "GHS",
      country = "Ghana",
      days,
      channels,
      status = "live",
      paymentRef,
      flwTxId,
      paidAt,
      liveAt,
      expiresAt,
      views = 0,
      listenerReach = 0,
      engagements = 0,
    } = req.body;

    // ─── Required field validation ────────────────────────────────
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

    // ─── Resolve pricing from tier ────────────────────────────────
    const tierData = tierFor(tier, country);
    if (!tierData) {
      return res.status(400).json({ message: `Unknown tier: ${tier}` });
    }

    const now = new Date();
    const daysResolved = days ?? tierData.days;
    const amountResolved = amount ?? tierData.amount;
    const channelsResolved = channels ?? tierData.channels;

    // ─── Build the document ───────────────────────────────────────
    const doc = {
      // Owner — provided in body OR admin themselves (guaranteed defined)
      userId: userId || adminId,

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
        ? adminId
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

    // Debug log — if this ever fails again, one look here tells you what's wrong
    console.log("[admin/promotions POST] creating:", {
      adminId,
      userId: doc.userId,
      businessName: doc.businessName,
      title: doc.title,
      status: doc.status,
      tier: doc.tier,
      videoUrl: doc.videoUrl ? "✓" : "✗ MISSING",
      coverImage: doc.coverImage ? "✓" : "(none — will auto-derive from video)",
    });

    const promotion = await new Promotion(doc).save();

    console.log(
      `[admin/promotions POST] created ${promotion._id} status=${status} by admin=${adminId}`,
    );
    res.status(201).json({ promotion });
  } catch (err) {
    console.error("[admin/promotions POST]", err);
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
// PATCH /admin/promotions/:id
// Body: { action, notes?, reason?, metrics? }
// ═══════════════════════════════════════════════════════════════════════
router.patch("/:id", async (req, res) => {
  try {
    const adminId = resolveAdminId(req);
    if (!adminId) {
      console.error(
        "[admin/promotions PATCH] cannot resolve admin id. req.user =",
        req.user,
      );
      return res.status(401).json({ message: "Not authenticated" });
    }

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

    const promo = await Promotion.findById(req.params.id);
    if (!promo) return res.status(404).json({ message: "Promotion not found" });

    const now = new Date();
    const set = {};
    let emailToSend = null;

    switch (action) {
      case "start_review":
        if (promo.status !== "submitted") {
          return res
            .status(409)
            .json({ message: `Must be "submitted", is "${promo.status}"` });
        }
        set.status = "under_review";
        set.reviewedAt = now;
        set.reviewedBy = adminId;
        if (notes) set.reviewNotes = notes;
        break;

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
        set.reviewedBy = promo.reviewedBy || adminId;
        set.reviewedAt = promo.reviewedAt || now;
        if (notes) set.reviewNotes = notes;
        emailToSend = { kind: "approved", notes };
        break;

      case "mark_live":
        // Allow from paid (normal flow) OR payment_pending (offline payment)
        if (!["paid", "payment_pending"].includes(promo.status)) {
          return res.status(409).json({
            message: `Must be "paid" or "payment_pending", is "${promo.status}"`,
          });
        }
        set.status = "live";
        set.liveAt = now;
        set.paidAt = promo.paidAt || now;
        set.expiresAt = new Date(Date.now() + (promo.days || 7) * 86400 * 1000);
        emailToSend = { kind: "live" };
        break;

      case "expire":
        set.status = "expired";
        set.expiresAt = now;
        break;

      case "reject":
        set.status = "rejected";
        set.rejectedAt = now;
        set.rejectedBy = adminId;
        set.rejectionReason = reason || "";
        emailToSend = { kind: "rejected", reason };
        break;

      case "refund":
        set.status = "refunded";
        set.refundedAt = now;
        set.refundedBy = adminId;
        set.refundReason = reason || "";
        break;

      case "update_metrics":
        if (metrics?.views !== undefined) set.views = metrics.views;
        if (metrics?.listenerReach !== undefined)
          set.listenerReach = metrics.listenerReach;
        if (metrics?.engagements !== undefined)
          set.engagements = metrics.engagements;
        break;
    }

    // Surgical update — bypasses full-doc validation so legacy records don't blow up
    const updated = await Promotion.findByIdAndUpdate(
      req.params.id,
      { $set: set },
      { new: true, runValidators: false },
    );

    // ─── Fire email (async, non-blocking, never fails the request) ───
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
