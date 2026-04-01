// models/stats.js
// Daily platform snapshot — written by cron, read by admin dashboard.
// One document per day per country. Upserted so re-runs are idempotent.
import mongoose from "mongoose";

const statsSchema = new mongoose.Schema(
  {
    date: { type: String, required: true }, // "2026-04-01"
    country: { type: String, required: true }, // "Ghana" | "Nigeria" | "all"

    // Users
    totalUsers: { type: Number, default: 0 },
    newUsers: { type: Number, default: 0 },
    totalVendors: { type: Number, default: 0 },

    // Ads
    totalActiveAds: { type: Number, default: 0 },
    newAds: { type: Number, default: 0 },

    // Revenue
    revenueGHS: { type: Number, default: 0 },
    revenueNGN: { type: Number, default: 0 },

    // Engagement
    totalViews: { type: Number, default: 0 },
    totalContacts: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// One snapshot per day per country
statsSchema.index({ date: 1, country: 1 }, { unique: true });

export default mongoose.models.Stats || mongoose.model("Stats", statsSchema);
