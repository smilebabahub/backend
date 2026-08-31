// ═══════════════════════════════════════════════════════════════════════
// models/transferModel.js  — REPLACES the earlier version
// ═══════════════════════════════════════════════════════════════════════
//
// Clozar's widget owns the whole transfer: quoting, recipient capture,
// payment, and payout. We don't orchestrate any of it. This model is a
// RECORD of what happened, so users have a history inside SmileBaba.
//
// Deliberately not stored: card details, full account numbers, anything
// we don't need and shouldn't hold.

import mongoose from "mongoose";

const transferSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    provider: { type: String, default: "clozar" },

    /** Clozar's reference — our idempotency key. */
    payoutRef: { type: String, required: true, unique: true, index: true },

    sendAmount: Number,
    sendCurrency: String,
    receiveAmount: Number,
    receiveCurrency: String,
    rate: Number,
    fee: Number,

    recipientName: String,
    /** Last 4 only — we never store a full recipient number. */
    recipientPhone: String,

    status: {
      type: String,
      enum: ["completed", "pending", "failed"],
      default: "completed",
    },

    /** Raw widget payload, for support and reconciliation. */
    raw: mongoose.Schema.Types.Mixed,
  },
  { timestamps: true },
);

transferSchema.index({ user: 1, createdAt: -1 });

transferSchema.virtual("reference").get(function () {
  return this.payoutRef ?? `TXN-${String(this._id).slice(-6).toUpperCase()}`;
});

transferSchema.set("toJSON", { virtuals: true });
transferSchema.set("toObject", { virtuals: true });

export default mongoose.models.Transfer ??
  mongoose.model("Transfer", transferSchema);





// ═══════════════════════════════════════════════════════════════════════
// ENV
// ═══════════════════════════════════════════════════════════════════════
//
// client/.env.local  (Next.js — publishable key, client-side is correct)
//   NEXT_PUBLIC_CLOZAR_KEY=pk_clz_7B99A6048527238C1763928C
//
// mobile/.env
//   EXPO_PUBLIC_WEB_URL=https://www.smilebabahub.com
//
// Backend needs nothing new — it only records results.
