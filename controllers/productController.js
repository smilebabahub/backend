// controllers/productController.js
import Ad from "../models/adModel.js";
import {
  getFeedCache, setFeedCache, feedCacheKey,
} from "../lib/redis.js";

// ── GET /products — public feed ────────────────────────────────────────────
export const getProducts = async (req, res) => {
  try {
    const {
      category, sub, country, search,
      featured, minPrice, maxPrice, currency,
      sort = "newest", page = 1, limit = 20,
    } = req.query;

    const resolvedCountry = (country )?.trim() || "Ghana";

    // ── Redis cache — only for simple unconstrained browsing feeds ───────────
    // Skip cache for search / price-filter / sub-category (too many variants)
    const isCacheable = !search && !minPrice && !maxPrice && !sub && !featured && !currency;
    const cKey = isCacheable
      ? feedCacheKey({ country: resolvedCountry, category: category , sort: sort , page, limit })
      : null;

    if (cKey) {
      const cached = await getFeedCache(cKey);
      if (cached) {
        return res.status(200).json({ ...cached, fromCache: true });
      }
    }

    const filter = {
      "location.country": resolvedCountry,
      isActive: true,
      isSold:   false,
      isPaused: false,
    };

    if (category)             filter["category.main"]     = category;
    if (sub)                  filter["category.sub"]      = sub;
    if (featured === "true")  filter.isFeatured           = true;
    if (search)               filter.$text                = { $search: search };
    if (minPrice || maxPrice) {
      filter["price.amount"] = {};
      if (minPrice) filter["price.amount"].$gte = Number(minPrice);
      if (maxPrice) filter["price.amount"].$lte = Number(maxPrice);
    }
    if (currency) filter["price.currency"] = currency;

    const sortMap = {
      newest:     { "boost.isBoosted": -1, createdAt: -1 },
      oldest:     { createdAt: 1 },
      price_asc:  { "price.amount": 1 },
      price_desc: { "price.amount": -1 },
      popular:    { views: -1 },
    };

    const skip  = (Number(page) - 1) * Number(limit);
    const [total, docs] = await Promise.all([
      Ad.countDocuments(filter),
      Ad.find(filter)
        .sort(sortMap[sort] ?? sortMap.newest)
        .skip(skip)
        .limit(Number(limit))
        .populate("postedBy", "username profilePicture phone")
        .lean(),
    ]);

    const products = docs.map(normaliseProduct);
    const result = {
      products,
      meta: {
        total,
        page:       Number(page),
        limit:      Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
        hasNext:    skip + docs.length < total,
      },
    };

    // Write to cache (non-blocking — never delay the response)
    if (cKey) setFeedCache(cKey, result).catch(() => {});

    res.status(200).json(result);
  } catch (error) {
    console.error("getProducts error:", error);
    res.status(500).json({ message: "Failed to fetch products" });
  }
};

// ── GET /products/my — vendor's own listings ───────────────────────────────
// Response: { products: Product[], meta: {...} }
export const getMyProducts = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { page = 1, limit = 20 } = req.query;

    const skip  = (Number(page) - 1) * Number(limit);
    const total = await Ad.countDocuments({ postedBy: userId });
    const docs  = await Ad.find({ postedBy: userId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();

    res.status(200).json({
      products: docs.map(normaliseProduct),
      meta: {
        total,
        page:       Number(page),
        limit:      Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
        hasNext:    skip + docs.length < total,
      },
    });
  } catch (error) {
    console.error("getMyProducts error:", error);
    res.status(500).json({ message: "Failed to fetch your products" });
  }
};

// ── GET /products/:id ──────────────────────────────────────────────────────
// Response: { product: Product }
export const getProductById = async (req, res) => {
  try {
    const doc = await Ad.findById(req.params.id)
      .populate("postedBy", "username profilePicture phone")
      .lean();

    if (!doc) return res.status(404).json({ message: "Product not found" });

    // Increment views
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

// ── Normaliser — maps Ad document to the Product shape ─────────────────────
// Frontend's Product type expects: _id, title, images[], price (number),
// currency, location, seller, rating, views, isFeatured, createdAt
function normaliseProduct(doc) {
  return {
    _id:         doc._id,
    id:          doc._id,                            // legacy alias
    title:       doc.title,
    description: doc.description,
    category:    doc.category?.main ?? "",
    subcategory: doc.category?.sub  ?? "",
    images: (doc.images ?? []).map((img) =>
      typeof img === "string" ? img : img.url ?? ""
    ),
    price:       doc.price?.amount  ?? 0,
    currency:    doc.price?.currency ?? "GHS",
    priceDisplay:doc.price?.display  ?? null,
    location: {
      country:    doc.location?.country,
      countryCode:doc.location?.countryCode,
      region:     doc.location?.region,
      city:       doc.location?.city,
      address:    doc.location?.address,
    },
    seller: {
      _id:            doc.postedBy?._id ?? doc.postedBy,
      name:           doc.postedBy?.username,
      username:       doc.postedBy?.username,
      profilePicture: doc.postedBy?.profilePicture,
      phone:          doc.postedBy?.phone,
    },
    rating:    null,    // add your own rating model if needed
    views:     doc.views     ?? 0,
    isFeatured:doc.isFeatured ?? false,
    isActive:  doc.isActive  ?? true,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}