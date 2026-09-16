
// ═══════════════════════════════════════════════════════════════════════
// models/broadcastModel.js — NEW FILE
// ═══════════════════════════════════════════════════════════════════════

import mongoose from "mongoose";

const broadcastSchema = new mongoose.Schema(
  {
    title:       { type: String, required: true },
    message:     { type: String, required: true },
    actionUrl:   String,
    actionLabel: String,

    audience: {
      segment: {
        type: String,
        enum: ["all", "vendors", "buyers", "subscribers"],
        default: "all",
      },
      country: String,
      respectPushPreference: { type: Boolean, default: true },
    },

    sendPush: { type: Boolean, default: true },

    status: {
      type: String,
      enum: ["sending", "completed", "failed"],
      default: "sending",
      index: true,
    },

    // Counts, updated as it works through
    total:     { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    pushed:    { type: Number, default: 0 },
    failed:    { type: Number, default: 0 },

    // Where to resume from. This is what makes a crash mid-send
    // recoverable without double-notifying anyone.
    lastUserId: { type: mongoose.Schema.Types.ObjectId },

    error:       String,
    completedAt: Date,

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true },
);

broadcastSchema.index({ createdAt: -1 });

export default mongoose.models.Broadcast ??
  mongoose.model("Broadcast", broadcastSchema);


// The import belongs at the top of this file:


// ═══════════════════════════════════════════════════════════════════════
// models/notificationModel.js — TWO ADDITIONS
// ═══════════════════════════════════════════════════════════════════════
//
// Add "announcement" to the type enum.
//
// And a unique index on dedupeKey, if it isn't there already. It's what
// stops a resumed broadcast notifying anyone twice:
//
//     

