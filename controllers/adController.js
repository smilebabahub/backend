// controllers/adController.js
import { logError } from "../lib/errorLog.js";
import mongoose from "mongoose";
import Ad from "../models/adModel.js";
import User from "../models/user.js";
import Notification from "../models/notificationModel.js";
import {
  PRICING,
  PLAN_NAMES,
  getPlanLimit,
  getPlanDurationDays,
} from "../config/pricing.js";
import cloudinary, { deleteImages } from "../lib/cloudinary.js";
import {
  bustFeedCache,
  getFeedCache,
  setFeedCache,
  feedCacheKey,
} from "../lib/redis.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Calculate listing expiry date based on vendor's subscription plan */
// Plan sort priority — higher = shown first in feed
// Used to pre-compute subscription.planPriority on every ad
export const PLAN_PRIORITY = {
  premium: 3, // SuperSmile   — unlimited, 60d
  popular: 2, // HappySmile   — 10 ads, 30d
  standard: 1, // BasicSmile   — 5 ads, 30d
  Basic: 0, // Smile (free) — 1 ad, 3d
};

function getExpiryDate(planId) {
  const days = getPlanDurationDays(planId);
  return new Date(Date.now() + days * 86400000);
}

/** Build the standard ad response shape — strip internal fields */
function serializeAd(ad) {
  const obj = ad.toObject ? ad.toObject() : ad;
  return {
    ...obj,
    isExpired: obj.expiresAt ? new Date(obj.expiresAt) < new Date() : false,
    daysLeft: obj.expiresAt
      ? Math.max(
          0,
          Math.ceil((new Date(obj.expiresAt) - Date.now()) / 86400000),
        )
      : null,
    planPriority: obj.subscription?.planPriority ?? 0,
    plan: obj.subscription?.plan ?? "Basic",
    coverImage:
      obj.images?.find((i) => i.isCover)?.url ?? obj.images?.[0]?.url ?? null,
  };
}

// ── CREATE AD ──────────────────────────────────────────────────────────────
// POST /ads
// ── Nigerian state names — used to infer country from region ──────────────
const NG_STATES = new Set([
  "Lagos",
  "Abuja FCT",
  "Kano",
  "Oyo",
  "Rivers",
  "Kaduna",
  "Delta",
  "Ogun",
  "Anambra",
  "Imo",
  "Plateau",
  "Edo",
  "Borno",
  "Enugu",
  "Katsina",
  "Adamawa",
  "Cross River",
  "Akwa Ibom",
  "Sokoto",
  "Kwara",
  "Osun",
  "Ondo",
  "Bauchi",
  "Niger",
  "Gombe",
  "Kebbi",
  "Zamfara",
  "Yobe",
  "Taraba",
  "Ebonyi",
  "Ekiti",
  "Nassarawa",
  "Bayelsa",
  "Jigawa",
  "Benue",
  "Abia",
  "Kogi",
]);

// Well-known Nigerian cities that are unambiguous
const NG_CITIES = new Set([
  "Ikeja",
  "Lekki",
  "Victoria Island",
  "Surulere",
  "Yaba",
  "Ajah",
  "Festac",
  "Ikorodu",
  "Gbagada",
  "Oshodi",
  "Agege",
  "Alimosho",
  "Badagry",
  "Epe",
  "Port Harcourt",
  "Aba",
  "Onitsha",
  "Warri",
  "Benin City",
  "Calabar",
  "Uyo",
  "Enugu City",
  "Owerri",
  "Kaduna City",
  "Ibadan",
  "Kano City",
  "Abuja",
  "Maiduguri",
  "Ilorin",
  "Abeokuta",
  "Akure",
  "Osogbo",
]);

const GH_REGIONS = new Set([
  "Greater Accra",
  "Ashanti",
  "Western",
  "Eastern",
  "Central",
  "Northern",
  "Upper East",
  "Upper West",
  "Volta",
  "Brong-Ahafo",
  "Western North",
  "Ahafo",
  "Bono East",
  "Oti",
  "North East",
  "Savannah",
]);

/**
 * Infer the correct country from location + price signals.
 *
 * Priority (highest → lowest confidence):
 *   1. NGN currency          — unambiguous Nigerian signal
 *   2. Region is a Nigerian state — e.g. "Lagos", "Kano"
 *   3. City is a known Nigerian city — e.g. "Lekki", "Ikeja"
 *   4. +234 phone / 0xxx Nigerian local format
 *   5. GHS currency          — Ghana signal, but lower than region
 *      (because Nigerian vendors sometimes pick wrong currency)
 *   6. Region is a Ghanaian region
 *   7. Explicit location.country (least trusted — often stale)
 *
 * Why region beats currency:
 *   Nigerian vendors on a Ghana-defaulted account often post with GHS
 *   but enter their real state (Lagos, Abuja etc.). The region is a
 *   much more reliable signal in that scenario.
 */
function inferCountry(location, price, contact) {
  const currency = (price?.currency || "").toUpperCase();
  const region = (location?.region || "").trim();
  const city = (location?.city || "").trim();
  const phone = (contact?.phone || location?.phone || "").replace(/\s/g, "");
  const whatsapp = (contact?.whatsapp || "").replace(/\s/g, "");

  // 1. NGN currency — strongest Nigerian signal
  if (currency === "NGN") return { country: "Nigeria", countryCode: "NG" };

  // 2. Nigerian state in region field
  if (NG_STATES.has(region)) return { country: "Nigeria", countryCode: "NG" };

  // 3. Known Nigerian city
  if (NG_CITIES.has(city)) return { country: "Nigeria", countryCode: "NG" };

  // 4. Phone number signals
  // +234 international, 234xxx direct, 0xxx Nigerian local (07x, 08x, 09x)
  const isNGPhone = (p) =>
    p.startsWith("+234") || p.startsWith("234") || /^0[789]\d{9}$/.test(p); // Nigerian mobile: 080xxxxxxxx, 090xxxxxxxx

  if (isNGPhone(phone) || isNGPhone(whatsapp)) {
    return { country: "Nigeria", countryCode: "NG" };
  }

  // 5. GHS currency — Ghana signal, but only if nothing above said Nigeria
  if (currency === "GHS") return { country: "Ghana", countryCode: "GH" };

  // 6. Ghanaian region
  if (GH_REGIONS.has(region)) return { country: "Ghana", countryCode: "GH" };

  // 7. Explicit location.country (least trusted)
  if (location?.country === "Nigeria")
    return { country: "Nigeria", countryCode: "NG" };

  // Default
  return { country: "Ghana", countryCode: "GH" };
}

export const createAd = async (req, res) => {
  try {
    const userId = req.user.userId;

    const user = await User.findById(userId).select("role subscription");
    if (!user) return res.status(404).json({ message: "User not found" });

    const planId = user.subscription?.plan ?? "Basic";
    const planName = PLAN_NAMES[planId] ?? "Smile";
    const expiresAt = getExpiryDate(planId);

    // ── Plan limit check — count active listings ──────────────────────────
    const limit = getPlanLimit(planId);
    if (isFinite(limit)) {
      const activeCount = await Ad.countDocuments({
        postedBy: userId,
        isActive: true,
        expiresAt: { $gt: new Date() },
      });
      if (activeCount >= limit) {
        return res.status(403).json({
          message:
            `Your ${PLAN_NAMES[planId]} plan allows ${limit} active listing${limit === 1 ? "" : "s"}. ` +
            `You currently have ${activeCount}. Upgrade your plan to post more.`,
          code: "PLAN_LIMIT_REACHED",
          limit,
          current: activeCount,
          planId,
          upgradeUrl: "/subscription",
        });
      }
    }

    const {
      title,
      description,
      category,
      attributes,
      images,
      location,
      contact,
      price,
      negotiable,
      delivery,
      condition,
      tags,
      videoUrl,
    } = req.body;

    // ── Infer correct country — region/city/phone beats stale currency ──────
    const { country, countryCode } = inferCountry(location, price, contact);
    const resolvedLocation = {
      ...location,
      country,
      countryCode,
    };

    const ad = await Ad.create({
      title,
      description,
      slug: null,
      category,
      attributes: attributes ?? [],
      images: Array.isArray(images) ? images : [],
      videoUrl: videoUrl ?? null,
      price: {
        amount: Number(price.amount),
        currency: price.currency,
      },
      negotiable: negotiable ?? "not_sure",
      location: resolvedLocation,
      contact,
      delivery: delivery ?? { available: false, option: "pickup_only" },
      condition: condition ?? "not_applicable",
      tags: Array.isArray(tags)
        ? tags
        : typeof tags === "string"
          ? tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
      subscription: {
        plan: planId,
        package: planName,
        startedAt: new Date(),
        expiresAt,
        listingDays: getPlanDurationDays(planId),
      },
      moderation: { status: "approved" },
      isActive: true,
      postedBy: userId,
      expiresAt,
    });

    res.status(201).json({
      message: "Ad posted successfully.",
      ad: serializeAd(ad),
    });

    // Bust feed cache for the correct country
    bustFeedCache(country).catch(() => {});
  } catch (error) {
    logError("createAd", error);
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
      country,
      category,
      sub,
      leaf,
      minPrice,
      maxPrice,
      currency,
      condition,
      city,
      region,
      search,
      negotiable,
      sort = "newest",
      page = 1,
      limit = 20,
    } = req.query;

    // ── Country filter ─────────────────────────────────────────────────────
    const resolvedCountry = String(country || "").trim() || "Ghana";

    // ── Feed cache — serve from Redis when no complex filters are active ───
    // Cache only unfiltered feeds (country + category + sort + page + limit).
    // Search, price range, condition filters are too granular to cache usefully.
    const isSimpleFeed =
      !search &&
      !minPrice &&
      !maxPrice &&
      !condition &&
      !city &&
      !region &&
      !negotiable &&
      !currency &&
      !sub &&
      !leaf;

    if (isSimpleFeed) {
      const key = feedCacheKey({
        country: resolvedCountry,
        category,
        sort,
        page,
        limit,
      });
      const cached = await getFeedCache(key);
      if (cached) return res.status(200).json(cached);
    }
    const now = new Date();
    const skip = (Number(page) - 1) * Number(limit);
    const lim = Number(limit);

    // ── Build filter conditions ─────────────────────────────────────────────
    // All conditions collected into $and so multiple $or clauses don't clobber each other.
    const andClauses = [];

    // Country: match exact OR missing/empty (older ads without location.country)
    andClauses.push({
      $or: [
        { "location.country": resolvedCountry },
        { "location.country": { $exists: false } },
        { "location.country": "" },
        { "location.country": null },
      ],
    });

    // Moderation: approved, no moderation field (old records), or pending-but-active.
    // isActive:true is the primary ground truth — trust it even if status says pending.
    andClauses.push({
      $or: [
        { "moderation.status": "approved" },
        { "moderation.status": { $exists: false } },
        { "moderation.status": null },
        { "moderation.status": "" },
        { "moderation.status": "pending", isActive: true },
      ],
    });

    const baseFilter = {
      isActive: true,
      isSold: false,
      isPaused: false,
      $and: andClauses,
    };

    // Optional field filters (flat — no $or conflict)
    if (region)
      baseFilter["location.region"] = { $regex: region, $options: "i" };
    if (city) baseFilter["location.city"] = { $regex: city, $options: "i" };
    if (category) baseFilter["category.main"] = category;
    if (sub) baseFilter["category.sub"] = sub;
    if (leaf) baseFilter["category.leaf"] = leaf;
    if (condition) baseFilter.condition = condition;
    if (negotiable) baseFilter.negotiable = negotiable;
    if (currency) baseFilter["price.currency"] = currency;
    if (search) baseFilter.$text = { $search: search };
    if (minPrice || maxPrice) {
      baseFilter["price.amount"] = {};
      if (minPrice) baseFilter["price.amount"].$gte = Number(minPrice);
      if (maxPrice) baseFilter["price.amount"].$lte = Number(maxPrice);
    }

    // ── Public feed: active + low-priority expired ads ────────────────────
    // Expired ads are NOT hidden — they stay in the feed at the bottom with
    // a visual "expired" badge. This preserves marketplace density and gives
    // expired vendors indirect motivation to renew (their ad is still seen
    // but outranked by every paying vendor).
    //
    // Exclusions that DO hide an ad from the public feed:
    //   - isActive: false  (manually deactivated / sold / moderated out)
    //   - isSold: true
    //   - isPaused: true
    // expiresAt past does NOT hide the ad — it only affects sort position.
    const feedFilter = { ...baseFilter };

    // ── Sort ─────────────────────────────────────────────────────────────────
    // Feed priority (applied for "newest" and "popular" — not price sorts):
    //
    //  1. Boosted ads          (boost.isBoosted: true)  — absolute top
    //  2. Active, not expired  (isNotExpired: 1)
    //     a. SuperSmile  (planPriority 3)
    //     b. HappySmile  (planPriority 2)
    //     c. BasicSmile  (planPriority 1)
    //     d. Smile/Basic (planPriority 0)
    //  3. Expired ads          (isNotExpired: 0)         — bottom of feed
    //
    // We compute isNotExpired as a virtual sort field using $addFields in
    // an aggregation pipeline for the default feed. Price/oldest sorts skip
    // the plan priority to respect explicit user intent.
    //
    // For simplicity in the existing find() path, we map planPriority into
    // the sort. Expired ads naturally sort last because they have been
    // deprioritised by the expiresAt-based computed field.

    // const now = new Date();

    // For plan-aware sort we use aggregation; for explicit price sorts keep find().
    const usePlanSort = !sort || sort === "newest" || sort === "popular";

    const sortMap = {
      newest: null, // handled by aggregation below
      oldest: { createdAt: 1 },
      price_asc: { "price.amount": 1 },
      price_desc: { "price.amount": -1 },
      popular: null, // handled by aggregation below
    };
    const simpleSortQuery = sortMap[sort]; // null means use aggregation

    let ads;
    const total = await Ad.countDocuments(feedFilter);

    if (usePlanSort) {
      // Aggregation pipeline: add isActiveAndFresh virtual field for sort,
      // then sort by boost → active → plan tier → secondary criterion
      const secondarySort =
        sort === "popular" ? { views: -1 } : { createdAt: -1 };
      ads = await Ad.aggregate([
        { $match: feedFilter },
        {
          $addFields: {
            // 1 if not expired (or no expiresAt), 0 if expired
            isActiveAndFresh: {
              $cond: [
                {
                  $or: [
                    { $gt: ["$expiresAt", now] },
                    { $eq: ["$expiresAt", null] },
                    { $not: { $ifNull: ["$expiresAt", false] } },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
        {
          $sort: {
            "boost.isBoosted": -1, // boosted ads always first
            isActiveAndFresh: -1, // active/fresh before expired
            "subscription.planPriority": -1, // highest plan first within each group
            ...secondarySort, // newest or most popular within same plan
          },
        },
        { $skip: skip },
        { $limit: lim },
        {
          $lookup: {
            from: "users",
            localField: "postedBy",
            foreignField: "_id",
            as: "postedByUser",
            pipeline: [{ $project: { username: 1, profilePicture: 1 } }],
          },
        },
        {
          $addFields: {
            postedBy: { $arrayElemAt: ["$postedByUser", 0] },
          },
        },
        { $unset: "postedByUser" },
      ]);
    } else {
      // Simple find for price/oldest sorts — user intent overrides plan priority
      ads = await Ad.find(feedFilter)
        .sort(simpleSortQuery)
        .skip(skip)
        .limit(lim)
        .populate("postedBy", "username profilePicture")
        .lean();
    }

    const feedPayload = {
      ads: ads.map(serializeAd),
      meta: {
        total,
        page: Number(page),
        limit: lim,
        totalPages: Math.ceil(total / lim),
        hasNext: skip + ads.length < total,
      },
    };

    // Write to cache for simple feeds (5-minute TTL from redis.js FEED_TTL)
    if (isSimpleFeed) {
      const key = feedCacheKey({
        country: resolvedCountry,
        category,
        sort,
        page,
        limit,
      });
      setFeedCache(key, feedPayload).catch(() => {});
    }

    res.status(200).json(feedPayload);
  } catch (error) {
    logError("getAds", error);
    res.status(500).json({ message: "Failed to fetch ads" });
  }
};

// ── GET SINGLE AD ──────────────────────────────────────────────────────────
// GET /ads/:id
export const getAdById = async (req, res) => {
  try {
    const ad = await Ad.findById(req.params.id)
      .populate("postedBy", "username profilePicture phone")
      .lean();

    if (!ad || !ad.isActive) {
      return res.status(404).json({ message: "Ad not found" });
    }

    Ad.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }).exec();

    res.status(200).json({ ad: serializeAd(ad) });
  } catch (error) {
    logError("getAdById", error);
    res.status(500).json({ message: "Failed to fetch ad" });
  }
};

// ── GET AD BY SLUG ─────────────────────────────────────────────────────────
// GET /ads/slug/:slug
export const getAdBySlug = async (req, res) => {
  try {
    const ad = await Ad.findOne({
      slug: req.params.slug,
      isActive: true,
      isSold: false,
    })
      .populate("postedBy", "username profilePicture phone")
      .lean();

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
      return res
        .status(403)
        .json({ message: "Not authorised to update this ad" });
    }

    const allowed = [
      "title",
      "description",
      "category",
      "attributes",
      "images",
      "videoUrl",
      "price",
      "negotiable",
      "location",
      "contact",
      "delivery",
      "condition",
      "tags",
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
        ad[field] = req.body[field];
      }
    });

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
      return res
        .status(403)
        .json({ message: "Not authorised to delete this ad" });
    }

    // Delete images from Cloudinary (non-fatal if it fails)
    const publicIds = ad.images.map((img) => img.publicId).filter(Boolean);
    await deleteImages(publicIds);

    await ad.deleteOne();

    res.status(200).json({ message: "Ad deleted successfully" });

    // Bust feed cache so deleted ad disappears immediately
    bustFeedCache(ad.location?.country || "Ghana").catch(() => {});
  } catch (error) {
    console.error("deleteAd error:", error);
    res.status(500).json({ message: "Failed to delete ad" });
  }
};

// ── BOOST AD ───────────────────────────────────────────────────────────────
// ── BOOST AD ──────────────────────────────────────────────────────────────
// POST /ads/:id/boost
// Boosting now requires payment. This endpoint redirects the vendor to
// the payment flow. The actual boost activation happens in adBoostPaymentController
// after Flutterwave confirms payment.
export const boostAd = async (req, res) => {
  try {
    const ad = await Ad.findById(req.params.id).select(
      "title postedBy isActive isSold",
    );
    if (!ad) return res.status(404).json({ message: "Ad not found" });

    if (String(ad.postedBy) !== req.user.userId) {
      return res
        .status(403)
        .json({ message: "Not authorised to boost this ad" });
    }
    if (!ad.isActive || ad.isSold) {
      return res
        .status(400)
        .json({ message: "Cannot boost a sold or inactive ad" });
    }

    const { tier = "standard" } = req.body;
    const validTiers = ["standard", "featured", "premium"];
    if (!validTiers.includes(tier)) {
      return res.status(400).json({ message: "Invalid boost tier" });
    }

    // Return payment instructions — the frontend should use the boost payment route
    res.status(402).json({
      requiresPayment: true,
      message: "Boosting requires payment. Use the boost payment endpoint.",
      paymentEndpoints: {
        GHS: `/payments/boost/gh/initialize`,
        NGN: `/payments/boost/ng/initialize`,
      },
      body: { adId: req.params.id, tier },
    });
  } catch (error) {
    console.error("boostAd error:", error);
    res.status(500).json({ message: "Failed to process boost request" });
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
      isSold: true,
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
      message: newPaused ? "Ad paused" : "Ad reactivated",
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

    if (status === "active") {
      filter.isActive = true;
      filter.isSold = false;
      filter.isPaused = false;
    }
    if (status === "paused") {
      filter.isPaused = true;
    }
    if (status === "sold") {
      filter.isSold = true;
    }
    if (status === "expired") {
      filter.isActive = false;
      filter.isSold = false;
      filter.expiresAt = { $lt: new Date() };
    }
    if (status === "pending") {
      filter["moderation.status"] = "pending";
    }

    const skip = (Number(page) - 1) * Number(limit);
    const total = await Ad.countDocuments(filter);

    const ads = await Ad.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();

    const now = new Date();

    // Summary stats — includes expiredCount and expiringSoonCount for dashboard badges
    const [
      activeCount,
      soldCount,
      pausedCount,
      expiredCount,
      expiringSoonCount,
      totalViews,
    ] = await Promise.all([
      Ad.countDocuments({
        postedBy: userId,
        isActive: true,
        isSold: false,
        isPaused: false,
        $or: [{ expiresAt: { $gt: now } }, { expiresAt: null }],
      }),
      Ad.countDocuments({ postedBy: userId, isSold: true }),
      Ad.countDocuments({ postedBy: userId, isPaused: true }),
      // Expired: isActive but expiresAt in the past
      Ad.countDocuments({
        postedBy: userId,
        isActive: true,
        isSold: false,
        expiresAt: { $lte: now },
      }),
      // Expiring in ≤3 days
      Ad.countDocuments({
        postedBy: userId,
        isActive: true,
        isSold: false,
        expiresAt: { $gt: now, $lte: new Date(now.getTime() + 3 * 86400000) },
      }),
      Ad.aggregate([
        { $match: { postedBy: new mongoose.Types.ObjectId(userId) } },
        { $group: { _id: null, total: { $sum: "$views" } } },
      ]).then((r) => r[0]?.total ?? 0),
    ]);

    res.status(200).json({
      ads: ads.map(serializeAd),
      meta: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
      },
      stats: {
        activeCount,
        soldCount,
        pausedCount,
        expiredCount,
        expiringSoonCount,
        totalViews,
      },
    });
  } catch (error) {
    logError("getMyAds", error);
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
        "moderation.status": status,
        "moderation.reviewedBy": req.user.userId,
        "moderation.reviewedAt": new Date(),
        "moderation.rejectReason": rejectReason ?? null,
        // Auto-activate on approval, deactivate on rejection
        isActive: status === "approved",
      },
      { new: true },
    );

    if (!ad) return res.status(404).json({ message: "Ad not found" });

    // Notify the ad owner
    const notifType =
      status === "approved"
        ? "ad_approved"
        : status === "rejected"
          ? "ad_rejected"
          : "ad_flagged";

    const notifMessages = {
      approved: `Your ad "${ad.title.slice(0, 50)}" is now live!`,
      rejected: `Your ad "${ad.title.slice(0, 50)}" was not approved. ${rejectReason ? `Reason: ${rejectReason}` : ""}`,
      flagged: `Your ad "${ad.title.slice(0, 50)}" has been flagged for review.`,
    };

    await Notification.findOneAndUpdate(
      { dedupeKey: `moderation-${ad._id}-${status}` },
      {
        user: ad.postedBy,
        type: notifType,
        title:
          status === "approved"
            ? "Ad approved"
            : status === "rejected"
              ? "Ad not approved"
              : "Ad flagged",
        message: notifMessages[status],
        actionUrl: `/ads/${ad._id}`,
        actionLabel: "View ad",
        dedupeKey: `moderation-${ad._id}-${status}`,
      },
      { upsert: true },
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
    if (!q || String(q).length < 2)
      return res.status(200).json({ suggestions: [] });

    const filter = {
      isActive: true,
      "moderation.status": "approved",
      title: { $regex: q, $options: "i" },
    };
    if (country) filter["location.country"] = country;

    const ads = await Ad.find(filter)
      .limit(8)
      .select("title category.main slug")
      .lean();

    res.status(200).json({
      suggestions: ads.map((a) => ({
        label: a.title,
        category: a.category?.main,
        slug: a.slug,
      })),
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch suggestions" });
  }
};
