// models/news.js
// News article schema — admin-authored content for /news pages and homepage ticker.

import mongoose from "mongoose";

const newsSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      index: true,
    },
    excerpt: {
      type: String,
      maxlength: 500,
    },
    content: {
      type: String, // Markdown or HTML
      required: true,
    },
    category: {
      type: String,
      enum: [
        "Economy",
        "Jobs",
        "Trade",
        "Sports",
        "Tech",
        "Politics",
        "Health",
        "Entertainment",
      ],
      default: "Economy",
      index: true,
    },
    // Either an uploaded image OR an emoji+colour combo (used as fallback)
    coverImage: { type: String, default: null }, // Cloudinary URL
    coverEmoji: { type: String, default: "📰" }, // Used when no image
    coverBg: { type: String, default: "bg-gray-100" },

    country: {
      type: String,
      enum: ["Ghana", "Nigeria", "All"],
      default: "All",
      index: true,
    },
    tags: { type: [String], default: [] },

    // Publishing
    status: {
      type: String,
      enum: ["draft", "published", "archived"],
      default: "draft",
      index: true,
    },
    publishedAt: { type: Date, default: null, index: true },

    // Authoring
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    authorName: { type: String, default: "SmileBaba Editorial" },

    // Engagement
    views: { type: Number, default: 0 },

    // SEO
    metaTitle: { type: String, default: "" },
    metaDescription: { type: String, default: "" },
    metaKeywords: { type: [String], default: [] },
  },
  { timestamps: true },
);

// Compound indexes for the most common queries
newsSchema.index({ status: 1, publishedAt: -1 });
newsSchema.index({ status: 1, country: 1, publishedAt: -1 });
newsSchema.index({ status: 1, category: 1, publishedAt: -1 });

// Auto-generate slug from title if missing
newsSchema.pre("validate", function (next) {
  if (this.title && !this.slug) {
    this.slug = this.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);
  }
  // Auto-set publishedAt when status changes to published
  if (this.status === "published" && !this.publishedAt) {
    this.publishedAt = new Date();
  }
  next();
});

export default mongoose.models.News ?? mongoose.model("News", newsSchema);
