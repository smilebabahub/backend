// backend/routes/promotionRoutes.js
//
// Public promotion routes. Same as before, PLUS:
//   - /submit now fires the confirmation email after creating the promo
//   - all env checks happen at request time so a missing FLW key can't crash boot

import express from "express";

import Promotion from "../models/promotion.js";
import { authenticate } from "../middleware/authMiddleWare.js";
import { tiersFor, tierFor } from "../config/promoPricing.js";
import {
  getOverviewStats,
  getPublicStats,
} from "../services/promotionStats.js";
import { sendPromotionSubmittedEmail } from "../services/email.js";
import jwt from "jsonwebtoken";

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════════
// GET /promote/pricing
// ═══════════════════════════════════════════════════════════════════════
router.get("/pricing", async (req, res) => {
  try {
    const currency =
      req.query.currency || (req.query.country === "Nigeria" ? "NGN" : "GHS");
    res.json({ tiers: tiersFor(currency), currency });
  } catch (err) {
    console.error("[promote/pricing]", err);
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// GET /promote/stats
// ═══════════════════════════════════════════════════════════════════════
router.get("/stats", async (req, res) => {
  try {
    res.json(await getPublicStats());
  } catch (err) {
    console.error("[promote/stats]", err);
    res.status(500).json({ message: err.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════
// GET /promote/active   (public)
//
// Replace the existing /active handler in routes/promotionRoutes.js
// with this one. Adds:
//   - Pagination (page + limit up to 60)
//   - Category filter
//   - Optional status filter (default "live", can also fetch "expired"
//     for a "recently ended" section if you want it later)
//   - Total count in response for pagination UI
//
// Homepage keeps working — it passes only `limit`.
// ═══════════════════════════════════════════════════════════════════════
 
router.get("/active", async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit  = Math.min(60, parseInt(req.query.limit, 10) || 12);
    const skip   = (page - 1) * limit;
 
    const status   = req.query.status   || "live";
    const country  = req.query.country;
    const category = req.query.category;
    const tier     = req.query.tier;
    const search   = req.query.search;
  
 
    const filter = { status };
    if (country)  filter.country  = country;
    if (category) filter.category = category;
    if (tier)     filter.tier     = tier;
    if (search) {
      filter.$or = [
        { businessName: { $regex: search, $options: "i" } },
        { title:        { $regex: search, $options: "i" } },
        { description:  { $regex: search, $options: "i" } },
      ];
    }
 
    // Sort: live promotions first by go-live date, then by createdAt
    const sort = status === "live"
      ? { liveAt: -1, createdAt: -1 }
      : { expiresAt: -1, createdAt: -1 };
 
    const [promotions, total, categories] = await Promise.all([
      Promotion.find(filter)
        .sort(sort)
        .skip(skip).limit(limit)
        .select("businessName contactName title description videoUrl coverImage thumbnailUrl category tier country liveAt expiresAt views")
        .lean(),
      Promotion.countDocuments(filter),
      // Also return distinct categories currently in play — for filter UI
      Promotion.distinct("category", { status }).then((arr) => arr.filter(Boolean)),
    ]);
 
    res.json({
      promotions,
      categories,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    console.error("[promote/active]", err);
    res.status(500).json({ message: err.message });
  }
});




// ═══════════════════════════════════════════════════════════════════════
// GET /promote/admin-stats
// ═══════════════════════════════════════════════════════════════════════
router.get("/admin-stats", authenticate, async (req, res) => {
  try {
    if (req.user?.role !== "admin")
      return res.status(403).json({ message: "Admin only" });
    const filter = {};
    if (req.query.country) filter.country = req.query.country;
    res.json(await getOverviewStats(filter));
  } catch (err) {
    console.error("[promote/admin-stats]", err);
    res.status(500).json({ message: err.message });
  }
});




// ═══════════════════════════════════════════════════════════════════════
// GET /promote/my
// ═══════════════════════════════════════════════════════════════════════
router.get("/my", authenticate, async (req, res) => {
  try {
    // Resolve user id from whatever shape auth middleware set
    const userId =
      req.user?._id ?? req.user?.id ?? req.user?.userId ?? req.auth?.userId;
    if (!userId) return res.status(401).json({ message: "Not authenticated" });

    const promotions = await Promotion.find({ userId })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ promotions });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});





// ═══════════════════════════════════════════════════════════════════════
// POST /promote/submit   → sends confirmation email
// ═══════════════════════════════════════════════════════════════════════
router.post("/submit", authenticate, async (req, res) => {
  try {
    const userId =
      req.user?._id ?? req.user?.id ?? req.user?.userId ?? req.auth?.userId;
    if (!userId) {
      console.error("[promote/submit] no user id on req.user =", req.user);
      return res.status(401).json({ message: "Not authenticated" });
    }

    const {
      tier,
      businessName,
      contactName,
      contactEmail,
      contactPhone,
      preferredContact,
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
      country: countryFromBody,
    } = req.body;

    // Required fields
    const missing = [];
    if (!tier) missing.push("tier");
    if (!title) missing.push("title");
    if (!contactEmail) missing.push("contactEmail");
    if (!contactPhone) missing.push("contactPhone");
    if (!videoUrl) missing.push("videoUrl");
    if (missing.length) {
      return res.status(400).json({
        message: `Missing required field${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
      });
    }

    // Resolve tier + country
    const country = countryFromBody || req.user.country || "Ghana";
    const t = tierFor(tier, country);
    if (!t) return res.status(400).json({ message: `Unknown tier: ${tier}` });

    // Create
    const promotion = await Promotion.create({
      userId,

      businessName: businessName || contactName || "",
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

      coverImage,
      videoUrl,
      videoName,
      thumbnailUrl,
      videoDuration,

      tier,
      amount: t.amount,
      currency: t.currency,
      country,
      days: t.days,
      channels: t.channels,

      status: "submitted",
      submittedIp: req.ip,
    });

    // ─── Send confirmation email (non-blocking) ──────────────────────
    // Fire and log — never fail the submission if email hiccups.
    sendPromotionSubmittedEmail({
      to: promotion.contactEmail,
      promotion,
    }).catch((e) => console.error("[promote/submit] email failed:", e.message));

    res.status(201).json({ promotion });
  } catch (err) {
    console.error("[promote/submit]", err);
    res.status(500).json({ message: err.message });
  }
});





// ═══════════════════════════════════════════════════════════════════════
// POST /promote/:id/pay
// ═══════════════════════════════════════════════════════════════════════
router.post("/:id/pay", authenticate, async (req, res) => {
  try {
    const userId =
      req.user?._id ?? req.user?.id ?? req.user?.userId ?? req.auth?.userId;
    if (!userId) return res.status(401).json({ message: "Not authenticated" });

    const promo = await Promotion.findById(req.params.id);
    if (!promo) return res.status(404).json({ message: "Promotion not found" });

    if (String(promo.userId) !== String(userId) && req.user.role !== "admin") {
      return res
        .status(403)
        .json({ message: "You can only pay for your own promotions" });
    }
    if (promo.status !== "payment_pending") {
      return res.status(409).json({
        message: `Cannot pay — promotion is "${promo.status}" (must be payment_pending)`,
      });
    }
    if (!process.env.FLW_SECRET_KEY) {
      return res
        .status(500)
        .json({ message: "Payment provider not configured" });
    }

    const frontendUrl = process.env.FRONTEND_URL || "https://smilebabahub.com";
    const txRef = `promo_${promo._id}_${Date.now()}`;

    // Use surgical update — same reason as admin PATCH: legacy records
    // might miss required fields and full-doc save would blow up.
    await Promotion.findByIdAndUpdate(
      promo._id,
      { $set: { paymentRef: txRef } },
      { runValidators: false },
    );

    const payload = {
      tx_ref: txRef,
      amount: promo.amount,
      currency: promo.currency,
      redirect_url: `${frontendUrl}/promote/success?ref=${txRef}`,
      payment_options: "card,mobilemoneyghana,mobilemoney,banktransfer",
      customer: {
        email: promo.contactEmail || req.user.email,
        phonenumber: promo.contactPhone || req.user.phone,
        name: promo.businessName || promo.contactName || req.user.username,
      },
      customizations: {
        title: "SmileBabaHub Promotion",
        description: `${promo.tier} — ${promo.title}`,
        logo: `${frontendUrl}/logo.png`,
      },
      meta: { promotionId: String(promo._id), userId: String(userId) },
    };

    const flwRes = await fetch("https://api.flutterwave.com/v3/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    const flwData = await flwRes.json();

    if (flwData.status !== "success" || !flwData.data?.link) {
      console.error("[promote/pay] Flutterwave error:", flwData);
      return res
        .status(502)
        .json({ message: "Could not start payment", details: flwData.message });
    }

    res.json({ status: "redirect", checkoutUrl: flwData.data.link, txRef });
  } catch (err) {
    console.error("[promote/:id/pay]", err);
    res.status(500).json({ message: err.message });
  }
});




// ═══════════════════════════════════════════════════════════════════════
// POST /promote/verify
// ═══════════════════════════════════════════════════════════════════════
router.post("/verify", async (req, res) => {
  try {
    const { txRef, transactionId } = req.body;
    const ref = txRef || req.body.tx_ref;
    if (!ref) return res.status(400).json({ message: "txRef required" });

    const promo = await Promotion.findOne({ paymentRef: ref });
    if (!promo) return res.status(404).json({ message: "Promotion not found" });

    if (["paid", "live"].includes(promo.status)) {
      return res.json({ status: promo.status, promotion: promo });
    }
    if (!process.env.FLW_SECRET_KEY) {
      return res
        .status(500)
        .json({ message: "Payment provider not configured" });
    }

    const verifyId = transactionId ?? req.body.id;
    if (!verifyId)
      return res.status(400).json({ message: "transactionId required" });

    const vRes = await fetch(
      `https://api.flutterwave.com/v3/transactions/${verifyId}/verify`,
      { headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}` } },
    );
    const vData = await vRes.json();
    const tx = vData.data;

    const isValid =
      vData.status === "success" &&
      tx?.status === "successful" &&
      Number(tx.amount) >= Number(promo.amount) &&
      tx.currency === promo.currency &&
      tx.tx_ref === ref;

    if (!isValid)
      return res
        .status(400)
        .json({ message: "Payment verification failed", vData });

    // Surgical update (same reason)
    const updated = await Promotion.findByIdAndUpdate(
      promo._id,
      { $set: { status: "paid", paidAt: new Date(), flwTxId: String(tx.id) } },
      { new: true, runValidators: false },
    );
    res.json({ status: "paid", promotion: updated });
  } catch (err) {
    console.error("[promote/verify]", err);
    res.status(500).json({ message: err.message });
  }
});



// ═══════════════════════════════════════════════════════════════════════
// POST /promote/webhook
// ═══════════════════════════════════════════════════════════════════════
router.post("/webhook", async (req, res) => {
  try {
    const signature = req.headers["verif-hash"];
    if (
      !process.env.FLW_WEBHOOK_HASH ||
      signature !== process.env.FLW_WEBHOOK_HASH
    ) {
      return res.status(401).json({ message: "Invalid signature" });
    }
    const event = req.body;
    if (
      event.event === "charge.completed" &&
      event.data?.status === "successful"
    ) {
      const promo = await Promotion.findOne({ paymentRef: event.data.tx_ref });
      if (promo && !["paid", "live"].includes(promo.status)) {
        await Promotion.findByIdAndUpdate(
          promo._id,
          {
            $set: {
              status: "paid",
              paidAt: new Date(),
              flwTxId: String(event.data.id),
            },
          },
          { runValidators: false },
        );
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("[promote/webhook]", err);
    res.sendStatus(500);
  }
});



// ═══════════════════════════════════════════════════════════════════════
// // GET /promote/:id
//
// Replace the existing handler at the bottom of routes/promotionRoutes.js
// with this version. Changes:
//   - Public users: only see live/expired (view count still increments)
//   - Signed-in owner: sees THEIR own campaign at any status
//   - Admin: sees anything
//
// The route stays public (no `authenticate` middleware) so it doesn't
// break the ActivePromotions component and homepage flow — but it
// OPTIONALLY reads the token if present to expand visibility.
// ═══════════════════════════════════════════════════════════════════════
router.get("/:id", async (req, res) => {
  try {
    const promo = await Promotion.findById(req.params.id).lean();
    if (!promo) return res.status(404).json({ message: "Not found" });

    // Publicly viewable statuses
    if (["live", "expired"].includes(promo.status)) {
      Promotion.updateOne({ _id: promo._id }, { $inc: { views: 1 } }).catch(
        () => {},
      );
      return res.json({ promotion: promo });
    }

    // Try to identify the caller via optional Bearer token
    let callerId = null;
    let callerRole = null;
    const auth = req.headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      try {
        const decoded = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
        callerId = decoded.id ?? decoded._id ?? decoded.userId;
        callerRole = decoded.role;
      } catch {
        // Invalid token — fall through to 404
      }
    }

    // Owner sees their own campaign at any status
    if (callerId && String(promo.userId) === String(callerId)) {
      return res.json({ promotion: promo });
    }

    // Admin sees anything
    if (callerRole === "admin") {
      return res.json({ promotion: promo });
    }

    // Everyone else — pretend it doesn't exist
    return res.status(404).json({ message: "Not found" });
  } catch (err) {
    console.error("[promote/:id]", err);
    res.status(500).json({ message: err.message });
  }
});

export default router;
