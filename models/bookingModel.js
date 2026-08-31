// models/booking.js
import mongoose from "mongoose";

const bookingSchema = new mongoose.Schema(
  {
    guest: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    ad: { type: mongoose.Schema.Types.ObjectId, ref: "Ad", required: true },
    propertyName: { type: String, required: true },
    // Free-form string — matches whatever subcategory the vendor chose in AdForm
    // e.g. "self-contained", "chamber & hall", "2-bedroom", "short stay", "studio"
    propertyType: { type: String, default: "apartment" },
    checkIn: { type: Date, required: true },
    checkOut: { type: Date, required: true },
    guests: { type: Number, default: 1, min: 1 },
    totalPrice: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ["GHS", "NGN"], default: "GHS" },
    status: {
      type: String,
      enum: ["pending", "paid", "confirmed", "checked_in", "checked_out", "refunded", "cancelled"],
      default: "pending",
    },
    txRef: { type: String, default: null },
    notes: { type: String, default: "" },
    // Stay maths — previously the client sent totalPrice and we trusted it
    nights: Number,
    nightlyRate: Number,

    // Commission, mirroring orders
    commissionRate: { type: Number, default: 0.05 },
    commissionAmount: Number,
    vendorPayout: Number,

    // Escrow — the host is paid after the guest confirms check-in
    escrowStatus: {
      type: String,
      enum: ["held", "released", "refunded", "disputed", "n/a"],
      default: "held",
    },
    escrowReleasedAt: Date,

    // Payment
    flwTxRef: String,
    flwTxId: String,
    paidAt: Date,

    // Lifecycle
    checkedInAt: Date,
    cancelledAt: Date,
    cancelledBy: { type: String, enum: ["guest", "vendor", "system"] },

    refundPolicy: {
      type: { type: String, default: "before_confirm" },
      window: Number,
    },

    timeline: [
      {
        status: { type: String, required: true },
        label: String,
        note: String,
        actor: { type: String, enum: ["buyer", "vendor", "system", "admin"] },
        at: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true },
);

bookingSchema.index({ guest: 1, createdAt: -1 });
bookingSchema.index({ vendor: 1, createdAt: -1 });
bookingSchema.index({ ad: 1, checkIn: 1, checkOut: 1 });
bookingSchema.index({ vendor: 1, createdAt: -1 });

export default mongoose.models.Booking ||
  mongoose.model("Booking", bookingSchema);
