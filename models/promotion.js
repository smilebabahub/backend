// models/promotion.js
// Promotional video campaign — vendor-submitted, admin-reviewed, paid via Flutterwave.

import mongoose from "mongoose";

const promotionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Campaign info
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    category: { type: String, default: "marketplace" },
    promotionType: { type: String, default: "Brand awareness" },
    targetRegion: { type: String, default: "" },
    targetAudience: { type: String, default: "Everyone" },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },

    // Media
    videoUrl: { type: String, required: true }, // Cloudinary URL
    videoName: { type: String, default: "" },
    thumbnailUrl: { type: String, default: null },

    // Pricing tier
    tier: {
      type: String,
      enum: ["starter", "growth", "enterprise"],
      required: true,
    },
    amount: { type: Number, required: true },
    currency: { type: String, enum: ["GHS", "NGN"], required: true },
    days: { type: Number, required: true },

    // Contact (in case different from account)
    contactName: { type: String, default: "" },
    contactPhone: { type: String, default: "" },
    contactEmail: { type: String, default: "" },
    preferredContact: {
      type: String,
      enum: ["email", "phone", "whatsapp"],
      default: "email",
    },

    // Lifecycle
    status: {
      type: String,
      enum: [
        "pending_review", // Just submitted, admin reviewing video
        "approved", // Approved, waiting for payment
        "rejected", // Rejected by admin
        "pending_payment", // Payment link sent
        "paid", // Paid, ready to schedule
        "scheduled", // Scheduled to go live
        "active", // Currently airing
        "completed", // Campaign finished
        "refunded", // Refunded
      ],
      default: "pending_review",
      index: true,
    },

    // Payment
    txRef: { type: String, default: null, index: true },
    transactionId: { type: String, default: null },
    paidAt: { type: Date, default: null },
    paymentLinkSent: { type: Boolean, default: false },
    paymentLink: { type: String, default: null },

    // Admin notes
    adminNotes: { type: String, default: "" },
    rejectionReason: { type: String, default: "" },

    // Scheduling
    scheduledStart: { type: Date, default: null },
    scheduledEnd: { type: Date, default: null },

    // Performance metrics (updated by analytics aggregations)
    metrics: {
      impressions: { type: Number, default: 0 },
      clicks: { type: Number, default: 0 },
      videoPlays: { type: Number, default: 0 },
      radioPlays: { type: Number, default: 0 },
      tvAirings: { type: Number, default: 0 },
      socialReach: { type: Number, default: 0 },
    },

    country: {
      type: String,
      enum: ["Ghana", "Nigeria"],
      required: true,
      index: true,
    },
  },
  { timestamps: true },
);

promotionSchema.index({ status: 1, createdAt: -1 });
promotionSchema.index({ user: 1, status: 1 });

export default mongoose.models.Promotion ??
  mongoose.model("Promotion", promotionSchema);
