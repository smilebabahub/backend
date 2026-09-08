// models/vendorOnboardingModel.js
//
// Vendor onboarding progress.
//
// ─── WHAT THIS DOES AND DOESN'T HOLD ─────────────────────────────────
//
// It holds *progress*, not vendor data. Store name, category, description
// and business type already live on User and are read by serializeUser,
// the storefront, the admin panel and half the web app. Duplicating them
// here would create two sources of truth and a guaranteed drift the first
// time someone edits their store from settings.
//
// So each step writes straight through to the User fields that already
// exist. This collection only tracks how far someone got, so they can
// resume — and records the commission acknowledgement, which needs a
// timestamp we can point at later.
//
// ─── EXISTING USERS ──────────────────────────────────────────────────
//
// Nobody who already sells fills this in. A completed record is derived
// from their account the first time they open the flow. See
// deriveFromUser in the controller.

import mongoose from "mongoose";

const vendorOnboardingSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },

    // ── Progress ─────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ["not_started", "in_progress", "complete", "suspended"],
      default: "not_started",
      index: true,
    },

    /** Highest step reached. Steps 2 to 7; step 1 is registration. */
    step: { type: Number, default: 2, min: 1, max: 7 },

    /**
     * Mirrors User.role, but only as "what they chose in the flow".
     * User.role stays the source of truth for permissions.
     */
    chosenType: {
      type: String,
      enum: ["vendor", "guest"],
    },

    // ── Step 5 · Services ────────────────────────────────────────────
    // Which surfaces they intend to sell on. Drives what we show them,
    // not what they're allowed to do. Also written to User.vendorServices
    // so the rest of the app can read it without joining.
    services: [
      {
        type: String,
        enum: ["ecommerce", "stays", "food", "marketplace"],
      },
    ],

    // ── Step 6 · Commission ──────────────────────────────────────────
    // Not a choice. Every sale is 5%. What's recorded is that they saw
    // the screen and confirmed — worth having a timestamp for if a
    // vendor ever disputes a deduction.
    acknowledgedCommission: { type: Boolean, default: false },
    acknowledgedAt: Date,
    /** The rate at the moment they agreed, in case it ever changes */
    acknowledgedRate: { type: Number, default: 0.05 },

    /** Whether to show them plans after finishing. Not a commitment. */
    wantsSubscription: { type: Boolean, default: false },

    completedAt: Date,

    /**
     * True when derived from an existing account rather than filled in.
     * These vendors never saw the commission screen, so they may need
     * telling another way.
     */
    grandfathered: { type: Boolean, default: false },

    // ── After the fact ───────────────────────────────────────────────
    suspendedAt: Date,
    suspendReason: String,
    suspendedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

vendorOnboardingSchema.index({ status: 1, createdAt: -1 });
vendorOnboardingSchema.index({ grandfathered: 1 });

export default mongoose.models.VendorOnboarding ??
  mongoose.model("VendorOnboarding", vendorOnboardingSchema);

// ═══════════════════════════════════════════════════════════════════════
// models/User.js — THREE ADDITIONS
//
// All additive, all optional. `strict: false` means they'd save without
// being declared, but then serializeUser can't see them and nothing in
// the app can read them back.
//
// Add near the store identity block:
//
//     storeAddress:   { type: String, default: "" },
//     vendorServices: [{ type: String }],
//
// And near the subscription block:
//
//     commissionAcknowledgedAt: { type: Date, default: null },
//
//
// ─── WHAT IS DELIBERATELY NOT ADDED ──────────────────────────────────
//
// No `accountType`. You already have `role: ["guest","vendor","admin"]`
// and serializeUser reads it. A second field naming the same thing means
// two sources of truth, and the first time one is updated without the
// other, permissions and UI disagree.
//
// No new KYC fields. `kycStatus.{identity,business,payment}` already
// exists and is the right home for verification when documents return.
// Onboarding leaves it alone — nothing here verifies anyone, so marking
// anything "verified" would be false.
// ═══════════════════════════════════════════════════════════════════════
