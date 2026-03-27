// controllers/adController.js
import Ad from "../models/adModel.js";
import User from "../models/user.js";
import Notification from "../models/notificationModel.js";
import { PRICING, PLAN_NAMES } from "../config/pricing.js";
import cloudinary, { deleteImages } from "../lib/cloudinary.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Calculate listing expiry date based on vendor's subscription plan */
function getExpiryDate(planId) {
  const daysMap = { Basic: 3, standard: 30, popular: 30, premium: 30 };
  const days    = daysMap[planId] ?? 3;
  return new Date(Date.now() + days * 86400000);
}

/** Build the standard ad response shape — strip internal fields */
function serializeAd(ad) {
  const obj = ad.toObject ? ad.toObject() : ad;
  return {
    ...obj,
    isExpired:  obj.expiresAt ? new Date(obj.expiresAt) < new Date() : false,
    daysLeft:   obj.expiresAt
      ? Math.max(0, Math.ceil((new Date(obj.expiresAt) - Date.now()) / 86400000))
      : null,
    coverImage: obj.images?.find((i) => i.isCover)?.url ?? obj.images?.[0]?.url ?? null,
  };
}

// ── CREATE AD ──────────────────────────────────────────────────────────────
// POST /ads
export const createAd = async (req, res) => {
  try {
    const userId = req.user.userId;

    const user = await User.findById(userId).select("role subscription");
    if (!user) return res.status(404).json({ message: "User not found" });

    const planId   = user.subscription?.plan ?? "Basic";
    const planName = PLAN_NAMES[planId] ?? "Smile";
    const expiresAt = getExpiryDate(planId);

    const {
      title, description, category, attributes, images,
      location, contact, price, negotiable, delivery,
      condition, tags, videoUrl,
    } = req.body;

    const isDev = process.env.NODE_ENV !== "production";

    const ad = await Ad.create({
      title,
      description,
      slug: null,
      category,
      attributes: attributes ?? [],
      images:     Array.isArray(images) ? images : [],
      videoUrl:   videoUrl ?? null,
      price: {
        amount:   Number(price.amount),
        currency: price.currency,
      },
      negotiable: negotiable ?? "not_sure",
      location,
      contact,
      delivery:   delivery ?? { available: false, option: "pickup_only" },
      condition:  condition ?? "not_applicable",
      tags: Array.isArray(tags)
        ? tags
        : (typeof tags === "string" ? tags.split(",").map((t) => t.trim()).filter(Boolean) : []),
      subscription: {
        plan:        planId,
        package:     planName,
        startedAt:   new Date(),
        expiresAt,
        listingDays: planId === "Basic" ? 3 : 30,
      },
      // In dev: auto-approve so ads show immediately without an admin step.
      // In production: all ads start as "pending" and need admin approval.
      moderation: {
        status: isDev ? "approved" : "pending",
      },
      isActive:  isDev, // active immediately in dev
      postedBy:  userId,
      expiresAt,
    });

    res.status(201).json({
      message: "Ad created successfully and is pending review.",
      ad: serializeAd(ad),
    });
  } catch (error) {
    console.error("createAd error:", error);
    res.status(500).json({ message: "Failed to create ad" });
  }
};

// ── GET ALL ADS (public feed) ──────────────────────────────────────────────
// GET /ads
// Query params: country, category, sub, leaf, minPrice, maxPrice,
//               condition, city, region, search, sort, page, limit
export const getAds = async (req, res) => {
  try {
    const {
      country, category, sub, leaf,
      minPrice, maxPrice, currency,
      condition, city, region,
      search, negotiable,
      sort = "newest",
      page = 1, limit = 20,
    } = req.query;

    const isDev = process.env.NODE_ENV !== "production";

    const filter = {
      isSold:   false,
      isPaused: false,
      $or: [
        { expiresAt: { $gt: new Date() } },
        { expiresAt: null },
      ],
    };

    // In production: only show approved ads and active listings.
    // In development: show all ads so you can see newly posted ads immediately.
    if (!isDev) {
      filter.isActive           = true;
      filter["moderation.status"] = "approved";
    }

    if (country)   filter["location.country"]  = country;
    if (region)    filter["location.region"]   = { $regex: region, $options: "i" };
    if (city)      filter["location.city"]     = { $regex: city,   $options: "i" };
    if (category)  filter["category.main"]     = category;
    if (sub)       filter["category.sub"]      = sub;
    if (leaf)      filter["category.leaf"]     = leaf;
    if (condition) filter.condition            = condition;
    if (negotiable)filter.negotiable           = negotiable;

    if (minPrice || maxPrice) {
      filter["price.amount"] = {};
      if (minPrice) (filter["price.amount"]).$gte = Number(minPrice);
      if (maxPrice) (filter["price.amount"]).$lte = Number(maxPrice);
    }
    if (currency) filter["price.currency"] = currency;

    // Full-text search
    if (search) {
      filter.$text = { $search: search };
    }

    // Sort options
    const sortMap = {
      newest:    { "boost.isBoosted": -1, createdAt: -1 },
      oldest:    { createdAt: 1 },
      price_asc: { "price.amount": 1 },
      price_desc:{ "price.amount": -1 },
      popular:   { views: -1 },
      // Boosted ads always float to top within any sort
    };
    const sortQuery = sortMap[sort] ?? sortMap.newest;

    const skip  = (Number(page) - 1) * Number(limit);
    const total = await Ad.countDocuments(filter);

    const ads = await Ad.find(filter)
      .sort(sortQuery)
      .skip(skip)
      .limit(Number(limit))
      .populate("postedBy", "username profilePicture")
      .lean();

    res.status(200).json({
      ads:  ads.map(serializeAd),
      meta: {
        total,
        page:       Number(page),
        limit:      Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
        hasNext:    skip + ads.length < total,
      },
    });
  } catch (error) {
    console.error("getAds error:", error);
    res.status(500).json({ message: "Failed to fetch ads" });
  }
};

// ── GET SINGLE AD ──────────────────────────────────────────────────────────
// GET /ads/:id
export const getAdById = async (req, res) => {
  try {
    const isDev = process.env.NODE_ENV !== "production";
    const ad = await Ad.findById(req.params.id)
      .populate("postedBy", "username profilePicture phone");

    if (!ad) {
      return res.status(404).json({ message: "Ad not found" });
    }

    // In production, hide inactive/unapproved ads from the public
    if (!isDev && (!ad.isActive || ad.moderation?.status === "rejected")) {
      return res.status(404).json({ message: "Ad not found" });
    }

    // Increment view count (fire-and-forget — don't await)
    Ad.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }).exec();

    res.status(200).json({ ad: serializeAd(ad) });
  } catch (error) {
    console.error("getAdById error:", error);
    res.status(500).json({ message: "Failed to fetch ad" });
  }
};

// ── GET AD BY SLUG ─────────────────────────────────────────────────────────
// GET /ads/slug/:slug
export const getAdBySlug = async (req, res) => {
  try {
    const ad = await Ad.findOne({ slug: req.params.slug, isActive: true })
      .populate("postedBy", "username profilePicture phone");

    if (!ad) return res.status(404).json({ message: "Ad not found" });

    Ad.findByIdAndUpdate(ad._id, { $inc: { views: 1 } }).exec();

    res.status(200).json({ ad: serializeAd(ad) });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch ad" });
  }
};

// ── UPDATE AD ──────────────────────────────────────────────────────────────
// PATCH /ads/:id
export const updateAd = async (req, res) => {
  try {
    const ad = await Ad.findById(req.params.id);
    if (!ad) return res.status(404).json({ message: "Ad not found" });

    // Only the owner or admin can update
    if (String(ad.postedBy) !== req.user.userId && req.user.role !== "admin") {
      return res.status(403).json({ message: "Not authorised to update this ad" });
    }

    const allowed = [
      "title", "description", "category", "attributes",
      "images", "videoUrl", "price", "negotiable",
      "location", "contact", "delivery", "condition", "tags",
    ];

    // If images are being replaced, delete the old ones from Cloudinary first
    if (req.body.images && Array.isArray(req.body.images)) {
      const oldPublicIds = (ad.images ?? [])
        .map((img) => img.publicId)
        .filter(Boolean);
      await deleteImages(oldPublicIds);
    }

    allowed.forEach((field) => {
      if (req.body[field] !== undefined) {
        (ad)[field] = req.body[field];
      }
    });

    // Re-trigger moderation on significant edits
    if (req.body.title || req.body.description || req.body.images) {
      ad.moderation.status = "pending";
    }

    await ad.save();

    res.status(200).json({
      message: "Ad updated successfully",
      ad: serializeAd(ad),
    });
  } catch (error) {
    console.error("updateAd error:", error);
    res.status(500).json({ message: "Failed to update ad" });
  }
};

// ── DELETE AD ──────────────────────────────────────────────────────────────
// DELETE /ads/:id
export const deleteAd = async (req, res) => {
  try {
    const ad = await Ad.findById(req.params.id);
    if (!ad) return res.status(404).json({ message: "Ad not found" });

    if (String(ad.postedBy) !== req.user.userId && req.user.role !== "admin") {
      return res.status(403).json({ message: "Not authorised to delete this ad" });
    }

    // Delete images from Cloudinary (non-fatal if it fails)
    const publicIds = ad.images.map((img) => img.publicId).filter(Boolean);
    await deleteImages(publicIds);

    await ad.deleteOne();

    res.status(200).json({ message: "Ad deleted successfully" });
  } catch (error) {
    console.error("deleteAd error:", error);
    res.status(500).json({ message: "Failed to delete ad" });
  }
};

// ── BOOST AD ───────────────────────────────────────────────────────────────
// POST /ads/:id/boost
export const boostAd = async (req, res) => {
  try {
    const ad = await Ad.findById(req.params.id);
    if (!ad) return res.status(404).json({ message: "Ad not found" });

    if (String(ad.postedBy) !== req.user.userId) {
      return res.status(403).json({ message: "Not authorised to boost this ad" });
    }

    const { tier = "standard" } = req.body;
    const boostDays = { standard: 7, featured: 14, premium: 30 };
    const days      = boostDays[tier ] ?? 7;

    await Ad.findByIdAndUpdate(req.params.id, {
      "boost.isBoosted":    true,
      "boost.boostedAt":    new Date(),
      "boost.boostedUntil": new Date(Date.now() + days * 86400000),
      "boost.boostTier":    tier,
    });

    res.status(200).json({
      message: `Ad boosted for ${days} days (${tier} tier)`,
    });
  } catch (error) {
    console.error("boostAd error:", error);
    res.status(500).json({ message: "Failed to boost ad" });
  }
};

// ── MARK AD AS SOLD ────────────────────────────────────────────────────────
// PATCH /ads/:id/sold
export const markAsSold = async (req, res) => {
  try {
    const ad = await Ad.findById(req.params.id);
    if (!ad) return res.status(404).json({ message: "Ad not found" });

    if (String(ad.postedBy) !== req.user.userId) {
      return res.status(403).json({ message: "Not authorised" });
    }

    await Ad.findByIdAndUpdate(req.params.id, {
      isSold:   true,
      isActive: false,
    });

    res.status(200).json({ message: "Ad marked as sold" });
  } catch (error) {
    res.status(500).json({ message: "Failed to mark ad as sold" });
  }
};

// ── TOGGLE PAUSE ───────────────────────────────────────────────────────────
// PATCH /ads/:id/pause
export const togglePause = async (req, res) => {
  try {
    const ad = await Ad.findById(req.params.id);
    if (!ad) return res.status(404).json({ message: "Ad not found" });

    if (String(ad.postedBy) !== req.user.userId) {
      return res.status(403).json({ message: "Not authorised" });
    }

    const newPaused = !ad.isPaused;
    await Ad.findByIdAndUpdate(req.params.id, {
      isPaused: newPaused,
      isActive: !newPaused,
    });

    res.status(200).json({
      message:  newPaused ? "Ad paused" : "Ad reactivated",
      isPaused: newPaused,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to toggle ad status" });
  }
};

// ── RECORD CONTACT CLICK ───────────────────────────────────────────────────
// POST /ads/:id/contact-click  (called from frontend when user taps phone/whatsapp)
export const recordContactClick = async (req, res) => {
  try {
    await Ad.findByIdAndUpdate(req.params.id, { $inc: { contactClicks: 1 } });
    res.status(200).json({ message: "Recorded" });
  } catch {
    res.status(500).json({ message: "Failed to record" });
  }
};

// ── GET MY ADS (vendor dashboard) ─────────────────────────────────────────
// GET /ads/my
export const getMyAds = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { status = "all", page = 1, limit = 20 } = req.query;

    const filter = { postedBy: userId };

    if (status === "active")  { filter.isActive = true;  filter.isSold = false; filter.isPaused = false; }
    if (status === "paused")  { filter.isPaused = true; }
    if (status === "sold")    { filter.isSold = true; }
    if (status === "expired") {
      filter.isActive  = false;
      filter.isSold    = false;
      filter.expiresAt = { $lt: new Date() };
    }
    if (status === "pending") { filter["moderation.status"] = "pending"; }

    const skip  = (Number(page) - 1) * Number(limit);
    const total = await Ad.countDocuments(filter);

    const ads = await Ad.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();

    // Summary stats
    const [activeCount, soldCount, pausedCount, totalViews] = await Promise.all([
      Ad.countDocuments({ postedBy: userId, isActive: true,  isSold: false }),
      Ad.countDocuments({ postedBy: userId, isSold: true }),
      Ad.countDocuments({ postedBy: userId, isPaused: true }),
      Ad.aggregate([
        { $match: { postedBy: new (await import("mongoose")).default.Types.ObjectId(userId) } },
        { $group: { _id: null, total: { $sum: "$views" } } },
      ]).then((r) => r[0]?.total ?? 0),
    ]);

    res.status(200).json({
      ads: ads.map(serializeAd),
      meta: {
        total, page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
      },
      stats: { activeCount, soldCount, pausedCount, totalViews },
    });
  } catch (error) {
    console.error("getMyAds error:", error);
    res.status(500).json({ message: "Failed to fetch your ads" });
  }
};

// ── ADMIN: MODERATE AD ─────────────────────────────────────────────────────
// PATCH /ads/:id/moderate  (admin only)
export const moderateAd = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const { status, rejectReason } = req.body;

    if (!["approved", "rejected", "flagged"].includes(status)) {
      return res.status(400).json({ message: "Invalid moderation status" });
    }

    const ad = await Ad.findByIdAndUpdate(
      req.params.id,
      {
        "moderation.status":       status,
        "moderation.reviewedBy":   req.user.userId,
        "moderation.reviewedAt":   new Date(),
        "moderation.rejectReason": rejectReason ?? null,
        // Auto-activate on approval, deactivate on rejection
        isActive: status === "approved",
      },
      { new: true }
    );

    if (!ad) return res.status(404).json({ message: "Ad not found" });

    // Notify the ad owner
    const notifType = status === "approved" ? "ad_approved"
      : status === "rejected" ? "ad_rejected"
      : "ad_flagged";

    const notifMessages = {
      approved: `Your ad "${ad.title.slice(0, 50)}" is now live!`,
      rejected: `Your ad "${ad.title.slice(0, 50)}" was not approved. ${rejectReason ? `Reason: ${rejectReason}` : ""}`,
      flagged:  `Your ad "${ad.title.slice(0, 50)}" has been flagged for review.`,
    };

    await Notification.findOneAndUpdate(
      { dedupeKey: `moderation-${ad._id}-${status}` },
      {
        user:       ad.postedBy,
        type:       notifType,
        title:      status === "approved" ? "Ad approved ✅" : status === "rejected" ? "Ad not approved ❌" : "Ad flagged ⚠️",
        message:    notifMessages[status],
        actionUrl:  `/ads/${ad._id}`,
        actionLabel:"View ad",
        dedupeKey:  `moderation-${ad._id}-${status}`,
      },
      { upsert: true }
    );

    res.status(200).json({ message: `Ad ${status}`, ad: serializeAd(ad) });
  } catch (error) {
    console.error("moderateAd error:", error);
    res.status(500).json({ message: "Failed to moderate ad" });
  }
};

// ── SEARCH SUGGESTIONS (autocomplete) ─────────────────────────────────────
// GET /ads/suggestions?q=toyota
export const getSearchSuggestions = async (req, res) => {
  try {
    const { q, country } = req.query;
    if (!q || String(q).length < 2) return res.status(200).json({ suggestions: [] });

    const filter = {
      isActive:            true,
      "moderation.status": "approved",
      title:               { $regex: q, $options: "i" },
    };
    if (country) filter["location.country"] = country;

    const ads = await Ad.find(filter)
      .limit(8)
      .select("title category.main slug")
      .lean();

    res.status(200).json({
      suggestions: ads.map((a) => ({
        label:    a.title,
        category: (a.category)?.main,
        slug:     a.slug,
      })),
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch suggestions" });
  }
};