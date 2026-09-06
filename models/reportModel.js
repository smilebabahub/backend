// models/reportModel.js
//
// A user report against a listing, a vendor, or a message.
//
// The design point worth naming: reports auto-hide a listing once enough
// distinct people flag it. A scam listing that stays up for two days
// while an admin sleeps does more damage than a real listing hidden for
// two hours by mistake — and the vendor can appeal.

import mongoose from "mongoose";

/**
 * Distinct reporters before a listing hides itself.
 *
 * Three is deliberate. One is too easy to abuse by a competitor; five
 * means a scam runs all day. Reports of the same reason count together,
 * so three people saying "scam" is a much stronger signal than three
 * people saying three different things — which is why REASON_WEIGHT
 * below lets fraud trip it faster.
 */
export const AUTO_HIDE_THRESHOLD = 3;

/** Some reasons are worth more than others. Fraud hides at two. */
export const REASON_WEIGHT = {
  scam: 1.5,
  counterfeit: 1.5,
  prohibited: 1.5,
  offensive: 1.2,
  misleading: 1,
  duplicate: 0.5,
  sold: 0.5,
  other: 1,
};

const reportSchema = new mongoose.Schema(
  {
    // ── What's being reported ────────────────────────────────────────
    ad: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ad",
      index: true,
    },
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    /** For reports raised from a chat rather than a listing */
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Conversation",
    },

    // ── Who ──────────────────────────────────────────────────────────
    // Nullable: a guest can report a scam without signing up first, and
    // making them register is how scams stay up.
    reporter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
    },
    reporterEmail: String,

    // ── Why ──────────────────────────────────────────────────────────
    reason: {
      type: String,
      enum: [
        "scam",
        "misleading",
        "prohibited",
        "duplicate",
        "sold",
        "offensive",
        "counterfeit",
        "other",
      ],
      required: true,
      index: true,
    },
    details: { type: String, maxlength: 1000 },

    // ── Handling ─────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["open", "reviewing", "actioned", "dismissed"],
      default: "open",
      index: true,
    },

    /** What an admin did about it */
    resolution: {
      type: String,
      enum: [
        "ad_removed",
        "ad_edited",
        "vendor_warned",
        "vendor_suspended",
        "no_action",
        "duplicate_report",
      ],
    },
    resolutionNote: String,
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reviewedAt: Date,

    /** True when this report is what pushed the listing over the line */
    triggeredAutoHide: { type: Boolean, default: false },

    // Snapshotted, because the listing may be edited or deleted before
    // anyone reviews the report
    snapshot: {
      title: String,
      price: Number,
      currency: String,
      category: String,
      vendorName: String,
    },

    ip: String,
  },
  { timestamps: true },
);

// The admin queue: open reports, oldest first
reportSchema.index({ status: 1, createdAt: 1 });

// Counting reports against one listing
reportSchema.index({ ad: 1, status: 1 });

// Stops the same person reporting the same listing twice. A sparse
// partial index so guest reports, which have no reporter, don't collide.
reportSchema.index(
  { ad: 1, reporter: 1 },
  {
    unique: true,
    partialFilterExpression: {
      ad: { $exists: true },
      reporter: { $exists: true },
    },
  },
);

reportSchema.virtual("reference").get(function () {
  return `RPT-${String(this._id).slice(-6).toUpperCase()}`;
});

reportSchema.set("toJSON", { virtuals: true });
reportSchema.set("toObject", { virtuals: true });

export default mongoose.models.Report ?? mongoose.model("Report", reportSchema);
