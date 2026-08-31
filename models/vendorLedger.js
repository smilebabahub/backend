// models/vendorLedger.js
//
// Vendor balance ledger — every credit (sale), debit (refund),
// and payout is a row. Vendor balance = SUM(amount WHERE status='available').
//
// Kept append-only. Never edit existing rows; add compensating entries instead
// (e.g. a refund is a negative-amount row, not a delete/update of the sale row).

import mongoose from "mongoose";

const vendorLedgerSchema = new mongoose.Schema(
  {
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    amount: {
      // Positive = credit to vendor, negative = debit
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      enum: ["GHS", "NGN"],
      required: true,
    },
    order: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      // Not required for adjustments/payouts
    },
    type: {
      type: String,
      enum: ["sale", "refund", "payout", "chargeback", "adjustment"],
      required: true,
    },
    status: {
      // pending  = escrow held, will become available on delivery confirmation
      // available = vendor can withdraw
      // paid_out  = money has left the platform
      type: String,
      enum: ["pending", "available", "paid_out"],
      default: "available",
    },
    booking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Booking",
      index: true,
    },
    notes: { type: String, default: "" },

    // For payouts: which withdrawal batch this ledger row belongs to
    payoutRef: { type: String, default: null, index: true },
  },
  { timestamps: true },
);

vendorLedgerSchema.index({ vendor: 1, status: 1, currency: 1 });
vendorLedgerSchema.index({ order: 1 });

export default mongoose.models.VendorLedger ||
  mongoose.model("VendorLedger", vendorLedgerSchema);
