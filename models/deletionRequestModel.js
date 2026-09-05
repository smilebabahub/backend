// models/deletionRequestModel.js
//
// An account deletion request and everything that happened to it.
//
// This is the audit trail Google Play and a data-protection regulator
// would both ask for: who asked, when they confirmed, when it completed,
// and what had to be kept.

import mongoose from "mongoose";

const deletionRequestSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: String,

    /** Null when no account matched — those are logged and rejected */
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },

    reason: String,
    notes: String,

    /**
     * Hashed, never stored raw — same reasoning as a password. If the
     * database leaks, the tokens in it are useless.
     */
    tokenHash: { type: String, index: true },
    tokenExpiresAt: Date,

    status: {
      type: String,
      enum: [
        "pending_confirmation",
        "confirmed",
        "completed",
        "cancelled",
        "rejected",
      ],
      default: "pending_confirmation",
      index: true,
    },

    confirmedAt: Date,
    /** Confirmation plus the grace period */
    scheduledFor: Date,
    completedAt: Date,
    cancelledAt: Date,
    cancelReason: String,

    /** What we couldn't delete and why — kept for the audit trail */
    retentionNotes: [String],

    ip: String,
  },
  { timestamps: true },
);

// The daily worker's query
deletionRequestSchema.index({ status: 1, scheduledFor: 1 });

export default mongoose.models.DeletionRequest ??
  mongoose.model("DeletionRequest", deletionRequestSchema);
