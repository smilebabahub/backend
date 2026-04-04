// models/analytics.js
// Stores page view events for the admin live activity feed.
// Lightweight — only keeps 24h of data, then TTL index removes old docs.

import mongoose from "mongoose";

const analyticsSchema = new mongoose.Schema(
  {
    // Page visited
    path: { type: String, required: true },
    // Country from cf-ipcountry
    country: { type: String, default: "Unknown" },
    // Whether user was logged in
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Basic device info
    device: {
      type: String,
      enum: ["mobile", "tablet", "desktop"],
      default: "desktop",
    },
    // Referrer domain
    referrer: { type: String, default: null },
    // TTL — MongoDB auto-deletes after 24h
    createdAt: { type: Date, default: Date.now, expires: 86400 },
  },
  { timestamps: false },
);

// Indexes for fast aggregation
analyticsSchema.index({ createdAt: -1 });
analyticsSchema.index({ country: 1, createdAt: -1 });
analyticsSchema.index({ path: 1, createdAt: -1 });

export default mongoose.models.Analytics ||
  mongoose.model("Analytics", analyticsSchema);
