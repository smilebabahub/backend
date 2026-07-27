// backend/models/promotion.js
//
// Adds `coverImage` — the poster image users upload alongside the video.
// This is what ActivePromotions cards render. Falls back to thumbnailUrl
// (auto-generated video poster) if not provided.

import mongoose from "mongoose";

export const TIERS = ["starter", "growth", "enterprise"];
export const STATUSES = [
  "submitted",
  "under_review",
  "payment_pending",
  "paid",
  "live",
  "expired",
  "rejected",
  "refunded",
];
export const CHANNELS = ["tv", "radio", "social", "web"];
export const CURRENCIES = ["GHS", "NGN"];
export const COUNTRIES = ["Ghana", "Nigeria"];

const promotionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // ── Business / contact info ──────────────────────────────────────
    businessName: { type: String, trim: true },
    contactName: { type: String, trim: true },
    contactEmail: { type: String, required: true, trim: true, lowercase: true },
    contactPhone: { type: String, trim: true },
    preferredContact: {
      type: String,
      enum: ["email", "phone", "whatsapp"],
      default: "email",
    },

    // ── Campaign details ─────────────────────────────────────────────
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    category: { type: String, trim: true },
    promotionType: { type: String, trim: true },
    targetRegion: { type: String, trim: true },
    targetAudience: { type: String, trim: true },
    startDate: { type: Date },

    // ── Creative assets ──────────────────────────────────────────────
    // coverImage:   the branded poster/cover the advertiser uploads.
    //               This is what shows on ActivePromotions cards, in
    //               emails, on the public detail page hero, etc.
    // thumbnailUrl: auto-derived poster from the video (Cloudinary
    //               transformation). Fallback when coverImage is empty.
    // videoUrl:     the actual video file the campaign plays.
    coverImage: { type: String, trim: true },
    videoUrl: { type: String, required: true },
    videoName: { type: String, trim: true },
    thumbnailUrl: { type: String },
    videoDuration: { type: Number },

    // ── Package chosen (snapshot at submit time) ─────────────────────
    tier: { type: String, enum: TIERS, required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: CURRENCIES, default: "GHS" },
    country: { type: String, enum: COUNTRIES, required: true, index: true },
    days: { type: Number, required: true, min: 1 },
    channels: [{ type: String, enum: CHANNELS }],


    // ── Status workflow ──────────────────────────────────────────────
    status: {
      type: String,
      enum: STATUSES,
      default: "submitted",
      index: true,
    },

    // ── Review ───────────────────────────────────────────────────────
    reviewedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reviewNotes: { type: String },
    paymentLinkSentAt: { type: Date },

    // ── Payment ──────────────────────────────────────────────────────
    paymentRef: { type: String, sparse: true, index: true },
    flwTxId: { type: String },
    paidAt: { type: Date, index: true },

    // ── Go-live / expiry ─────────────────────────────────────────────
    liveAt: { type: Date, index: true },
    expiresAt: { type: Date, index: true },

    // ── Rejection ────────────────────────────────────────────────────
    rejectedAt: { type: Date },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    rejectionReason: { type: String },

    // ── Refund ───────────────────────────────────────────────────────
    refundedAt: { type: Date },
    refundedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    refundReason: { type: String },

    // ── Analytics ────────────────────────────────────────────────────
    views: { type: Number, default: 0 },
    listenerReach: { type: Number, default: 0 },
    engagements: { type: Number, default: 0 },

    submittedIp: { type: String },
  },
  { timestamps: true },
);

// ─── Pre-save: auto-fill businessName + auto-derive thumbnail ─────────
// ─── Pre-save: auto-fill businessName + auto-derive thumbnail ─────────
// Async style — no `next` parameter needed. Mongoose awaits the returned
// promise. This is the modern recommended pattern and avoids all the
// "next is not a function" quirks entirely.
promotionSchema.pre("save", async function () {
  if (!this.businessName && this.contactName) {
    this.businessName = this.contactName;
  }

  // Auto-derive thumbnail from Cloudinary video URL
  if (!this.thumbnailUrl && this.videoUrl && this.videoUrl.includes("/video/upload/")) {
    this.thumbnailUrl = this.videoUrl
      .replace("/video/upload/", "/video/upload/w_640,h_360,c_fill,so_1/")
      .replace(/\.[^.]+$/, ".jpg");
  }

  // Auto-expire live campaigns past their end date
  if (this.status === "live" && this.expiresAt && this.expiresAt < new Date()) {
    this.status = "expired";
  }
});

// ─── Virtual: displayImage — the ONE image to show on cards ───────────
// Prefers user-uploaded coverImage → falls back to auto video thumbnail
// → falls back to null (frontend handles placeholder).
promotionSchema.virtual("displayImage").get(function () {
  return this.coverImage || this.thumbnailUrl || null;
});

// ─── Indexes ──────────────────────────────────────────────────────────
promotionSchema.index({ status: 1, paidAt: -1 });
promotionSchema.index({ status: 1, liveAt: -1 });
promotionSchema.index({ status: 1, expiresAt: 1 });
promotionSchema.index({ country: 1, status: 1 });
promotionSchema.index({ userId: 1, status: 1 });

promotionSchema.virtual("isActive").get(function () {
  if (this.status !== "live") return false;
  if (!this.expiresAt) return true;
  return this.expiresAt > new Date();
});

// ─── Backwards-compat virtuals ────────────────────────────────────────
promotionSchema.virtual("planTier").get(function () {
  return this.tier;
});
promotionSchema.virtual("plan").get(function () {
  return this.tier;
});
promotionSchema.virtual("duration").get(function () {
  return this.days;
});

promotionSchema.set("toJSON", { virtuals: true });
promotionSchema.set("toObject", { virtuals: true });

const Promotion = mongoose.model("Promotion", promotionSchema);
export default Promotion;
