// controllers/productController.js
import Ad from "../models/adModel.js";
import { getFeedCache, setFeedCache, feedCacheKey } from "../lib/redis.js";

// ── GET /products — public feed ────────────────────────────────────────────
export const getProducts = async (req, res) => {
  try {
    const {
      category,
      sub,
      country,
      search,
      featured,
      minPrice,
      maxPrice,
      currency,
      sort = "newest",
      page = 1,
      limit = 20,
    } = req.query;

    // Always resolve country — never let an empty string reach MongoDB
    const resolvedCountry = (country || "").trim() || "Ghana";

    // ── Redis cache — skip for searches / price filters (too many variants) ──
    const isCacheable =
      !search && !minPrice && !maxPrice && !sub && !featured && !currency;
    const cKey = isCacheable
      ? feedCacheKey({
          country: resolvedCountry,
          category: category || "all",
          sort,
          page,
          limit,
        })
      : null;

    if (cKey) {
      const cached = await getFeedCache(cKey);
      if (cached) return res.status(200).json({ ...cached, fromCache: true });
    }

    const now = new Date();
    const skip = (Number(page) - 1) * Number(limit);
    const lim = Number(limit);

    // ── Shared filters (country + category) ──────────────────────────────
    const andClauses = [
      // Country: exact match OR missing/empty (older records without country field)
      {
        $or: [
          { "location.country": resolvedCountry },
          { "location.country": { $exists: false } },
          { "location.country": "" },
          { "location.country": null },
        ],
      },
    ];

    const baseFilter = {
      isActive: true,
      isSold: false,
      isPaused: false,
      $and: andClauses,
    };

    if (category) baseFilter["category.main"] = category;
    if (sub) baseFilter["category.sub"] = sub;
    if (featured === "true") baseFilter.isFeatured = true;
    if (search) baseFilter.$text = { $search: search };
    if (currency) baseFilter["price.currency"] = currency;

    if (minPrice || maxPrice) {
      baseFilter["price.amount"] = {};
      if (minPrice) baseFilter["price.amount"].$gte = Number(minPrice);
      if (maxPrice) baseFilter["price.amount"].$lte = Number(maxPrice);
    }

    // ── Active filter: not yet expired (high priority) ───────────────────
    const activeFilter = {
      ...baseFilter,
      $and: [
        ...andClauses,
        {
          $or: [
            { expiresAt: { $gt: now } },
            { expiresAt: null },
            { expiresAt: { $exists: false } },
          ],
        },
      ],
    };

    // ── Expired filter: expired within last 30 days (low priority) ───────
    const thirtyDaysAgo = new Date(now - 30 * 86400000);
    const expiredFilter = {
      ...baseFilter,
      isActive: { $in: [true, false] },
      isSold: false,
      expiresAt: { $lte: now, $gte: thirtyDaysAgo },
    };

    const sortMap = {
      newest: { "boost.isBoosted": -1, createdAt: -1 },
      oldest: { createdAt: 1 },
      price_asc: { "price.amount": 1 },
      price_desc: { "price.amount": -1 },
      popular: { views: -1 },
    };
    const sortQuery = sortMap[sort] || sortMap.newest;

    // ── Fetch active products first ───────────────────────────────────────
    const [activeDocs, activeTotal] = await Promise.all([
      Ad.find(activeFilter)
        .sort(sortQuery)
        .skip(skip)
        .limit(lim)
        .populate("postedBy", "username profilePicture phone")
        .lean(),
      Ad.countDocuments(activeFilter),
    ]);

    // ── Pad remaining slots with expired products (low priority) ─────────
    const remaining = lim - activeDocs.length;
    let expiredDocs = [];
    let expiredTotal = 0;

    if (remaining > 0) {
      const expiredSkip = Math.max(0, skip - activeTotal);
      [expiredDocs, expiredTotal] = await Promise.all([
        Ad.find(expiredFilter)
          .sort({ expiresAt: -1 })
          .skip(expiredSkip)
          .limit(remaining)
          .populate("postedBy", "username profilePicture phone")
          .lean(),
        Ad.countDocuments(expiredFilter),
      ]);
    }

    const docs = [...activeDocs, ...expiredDocs];
    const total = activeTotal + expiredTotal;

    const products = docs.map(normaliseProduct);
    const result = {
      products,
      meta: {
        total,
        activeTotal,
        expiredTotal,
        page: Number(page),
        limit: lim,
        totalPages: Math.ceil(total / lim),
        hasNext: skip + docs.length < total,
      },
    };

    // Write to cache non-blocking — never delay the response
    if (cKey) setFeedCache(cKey, result).catch(() => {});

    res.status(200).json(result);
  } catch (error) {
    console.error("getProducts error:", error);
    res.status(500).json({ message: "Failed to fetch products" });
  }
};

// ── GET /products/my — vendor's own listings ───────────────────────────────
export const getMyProducts = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const [total, docs] = await Promise.all([
      Ad.countDocuments({ postedBy: userId }),
      Ad.find({ postedBy: userId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
    ]);

    res.status(200).json({
      products: docs.map(normaliseProduct),
      meta: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
        hasNext: skip + docs.length < total,
      },
    });
  } catch (error) {
    console.error("getMyProducts error:", error);
    res.status(500).json({ message: "Failed to fetch your products" });
  }
};

// ── GET /products/:id ──────────────────────────────────────────────────────
export const getProductById = async (req, res) => {
  try {
    const doc = await Ad.findById(req.params.id)
      .populate("postedBy", "username profilePicture phone")
      .lean();

    if (!doc) return res.status(404).json({ message: "Product not found" });

    Ad.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }).exec();

    res.status(200).json({ product: normaliseProduct(doc) });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch product" });
  }
};

// ── DELETE /products/:id ───────────────────────────────────────────────────
export const deleteProductById = async (req, res) => {
  try {
    const doc = await Ad.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: "Product not found" });

    if (String(doc.postedBy) !== req.user.userId && req.user.role !== "admin") {
      return res.status(403).json({ message: "Not authorised" });
    }

    await doc.deleteOne();
    res.status(200).json({ message: "Product deleted" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete product" });
  }
};

// ── Normaliser — maps Ad document → Product shape expected by frontend ─────
function normaliseProduct(doc) {
  return {
    _id: doc._id,
    id: doc._id,
    title: doc.title,
    description: doc.description,
    category: doc.category?.main ?? "",
    subcategory: doc.category?.sub ?? "",
    images: (doc.images ?? []).map((img) =>
      typeof img === "string" ? img : (img.url ?? ""),
    ),
    price: doc.price?.amount ?? 0,
    currency: doc.price?.currency ?? "GHS",
    priceDisplay: doc.price?.display ?? null,
    location: {
      country: doc.location?.country,
      countryCode: doc.location?.countryCode,
      region: doc.location?.region,
      city: doc.location?.city,
      address: doc.location?.address,
    },
    seller: {
      _id: doc.postedBy?._id ?? doc.postedBy,
      name: doc.postedBy?.username,
      username: doc.postedBy?.username,
      profilePicture: doc.postedBy?.profilePicture,
      phone: doc.postedBy?.phone,
    },
    rating: null,
    views: doc.views ?? 0,
    isFeatured: doc.isFeatured ?? false,
    isActive: doc.isActive ?? true,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
