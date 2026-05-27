// controllers/newsController.js
// News article CRUD — public read endpoints + admin write endpoints.
// Caching: published articles list cached in Redis for 60s per country/category.

import News from "../models/news.js";
import { logError } from "../lib/errorLog.js";
import { safeRedis } from "../lib/redis.js";

// ── Public: GET /news ─────────────────────────────────────────────────────
// List published articles. Filters: category, country, search, page.
export const getNews = async (req, res) => {
  try {
    const { category, country, search, limit = 12, page = 1 } = req.query;

    const filter = { status: "published" };
    if (category && category !== "All") filter.category = category;
    if (country) {
      // Show country-specific articles + "All" (global) articles
      filter.$or = [{ country }, { country: "All" }];
    }
    if (search) filter.$text = { $search: search };

    const lim = Math.min(Number(limit), 50);
    const skip = (Number(page) - 1) * lim;

    // Cache key: only cache common filters with no search
    const cacheKey = !search
      ? `news:list:${country ?? "all"}:${category ?? "all"}:${page}:${lim}`
      : null;

    if (cacheKey) {
      const cached = await safeRedis((c) => c.get(cacheKey));
      if (cached) {
        res.set("X-Cache", "HIT");
        return res.json(JSON.parse(cached));
      }
    }

    const [articles, total] = await Promise.all([
      News.find(filter)
        .sort({ publishedAt: -1 })
        .skip(skip)
        .limit(lim)
        .select("-content") // Don't ship full content in list views
        .populate("author", "username")
        .lean(),
      News.countDocuments(filter),
    ]);

    const result = {
      articles,
      meta: {
        total,
        page: Number(page),
        limit: lim,
        totalPages: Math.ceil(total / lim),
        hasNext: skip + articles.length < total,
      },
    };

    if (cacheKey) {
      safeRedis((c) => c.setEx(cacheKey, 60, JSON.stringify(result))).catch(
        () => {},
      );
    }

    res.set("Cache-Control", "public, max-age=60");
    res.json(result);
  } catch (err) {
    logError("getNews", err);
    res.status(500).json({ message: "Failed to load news" });
  }
};

// ── Public: GET /news/:slug ───────────────────────────────────────────────
export const getNewsBySlug = async (req, res) => {
  try {
    const article = await News.findOneAndUpdate(
      { slug: req.params.slug, status: "published" },
      { $inc: { views: 1 } }, // Track view count
      { new: true },
    ).populate("author", "username");

    if (!article) return res.status(404).json({ message: "Article not found" });

    // Fetch 3 related articles in the same category
    const related = await News.find({
      _id: { $ne: article._id },
      status: "published",
      category: article.category,
    })
      .sort({ publishedAt: -1 })
      .limit(3)
      .select("title slug coverEmoji coverBg coverImage category publishedAt")
      .lean();

    res.json({ article, related });
  } catch (err) {
    logError("getNewsBySlug", err);
    res.status(500).json({ message: "Failed to load article" });
  }
};

// ── Public: GET /news/ticker ──────────────────────────────────────────────
// Lightweight endpoint for the homepage news ticker — returns 5 latest titles.
export const getNewsTicker = async (req, res) => {
  try {
    const { country = "All" } = req.query;
    const cacheKey = `news:ticker:${country}`;

    const cached = await safeRedis((c) => c.get(cacheKey));
    if (cached) {
      res.set("X-Cache", "HIT");
      return res.json(JSON.parse(cached));
    }

    const items = await News.find({
      status: "published",
      $or: [{ country }, { country: "All" }],
    })
      .sort({ publishedAt: -1 })
      .limit(5)
      .select("title slug category coverEmoji coverBg coverImage publishedAt")
      .lean();

    const result = { items };
    safeRedis((c) => c.setEx(cacheKey, 120, JSON.stringify(result))).catch(
      () => {},
    );
    res.set("Cache-Control", "public, max-age=120");
    res.json(result);
  } catch (err) {
    logError("getNewsTicker", err);
    res.status(500).json({ message: "Failed to load ticker" });
  }
};

// ── Admin: POST /admin/news ───────────────────────────────────────────────
export const createNews = async (req, res) => {
  try {
    const {
      title,
      slug,
      excerpt,
      content,
      category,
      coverImage,
      coverEmoji,
      coverBg,
      country,
      tags,
      status,
      metaTitle,
      metaDescription,
      metaKeywords,
      authorName,
    } = req.body;

    if (!title || !content) {
      return res
        .status(400)
        .json({ message: "Title and content are required" });
    }

    const article = await News.create({
      title,
      slug,
      excerpt,
      content,
      category,
      coverImage,
      coverEmoji,
      coverBg,
      country,
      tags,
      status,
      metaTitle,
      metaDescription,
      metaKeywords,
      author: req.user.userId,
      authorName: authorName ?? "SmileBaba Editorial",
    });

    // Bust list caches when a new article is published
    if (status === "published") {
      safeRedis((c) =>
        c.keys("news:*").then((keys) => keys.length && c.del(keys)),
      ).catch(() => {});
    }

    res.status(201).json({ article });
  } catch (err) {
    if (err.code === 11000) {
      return res
        .status(409)
        .json({ message: "A news article with this slug already exists" });
    }
    logError("createNews", err);
    res.status(500).json({ message: "Failed to create article" });
  }
};

// ── Admin: PATCH /admin/news/:id ──────────────────────────────────────────
export const updateNews = async (req, res) => {
  try {
    const updates = { ...req.body };
    delete updates._id;
    delete updates.author;
    delete updates.views;

    // If publishing for the first time, set publishedAt
    if (updates.status === "published") {
      const existing = await News.findById(req.params.id)
        .select("publishedAt")
        .lean();
      if (existing && !existing.publishedAt) {
        updates.publishedAt = new Date();
      }
    }

    const article = await News.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });

    if (!article) return res.status(404).json({ message: "Article not found" });

    // Bust caches
    safeRedis((c) =>
      c.keys("news:*").then((keys) => keys.length && c.del(keys)),
    ).catch(() => {});

    res.json({ article });
  } catch (err) {
    logError("updateNews", err);
    res.status(500).json({ message: "Failed to update article" });
  }
};

// ── Admin: DELETE /admin/news/:id ─────────────────────────────────────────
export const deleteNews = async (req, res) => {
  try {
    const result = await News.findByIdAndDelete(req.params.id);
    if (!result) return res.status(404).json({ message: "Article not found" });

    safeRedis((c) =>
      c.keys("news:*").then((keys) => keys.length && c.del(keys)),
    ).catch(() => {});

    res.json({ message: "Article deleted" });
  } catch (err) {
    logError("deleteNews", err);
    res.status(500).json({ message: "Failed to delete article" });
  }
};

// ── Admin: GET /admin/news ────────────────────────────────────────────────
// Lists ALL articles (including drafts), no caching.
export const getAdminNewsList = async (req, res) => {
  try {
    const { status, category, search, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (category && category !== "All") filter.category = category;
    if (search) filter.$text = { $search: search };

    const lim = Math.min(Number(limit), 100);
    const skip = (Number(page) - 1) * lim;

    const [articles, total] = await Promise.all([
      News.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(lim)
        .select("-content")
        .populate("author", "username email")
        .lean(),
      News.countDocuments(filter),
    ]);

    res.json({
      articles,
      meta: {
        total,
        page: Number(page),
        limit: lim,
        totalPages: Math.ceil(total / lim),
      },
    });
  } catch (err) {
    logError("getAdminNewsList", err);
    res.status(500).json({ message: "Failed to load articles" });
  }
};
