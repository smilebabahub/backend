// models/bookingModel.js
//
// A stay booking.
//
// Every field bookingController writes is declared here. That matters
// more than usual: Mongoose silently drops unknown paths, so a missing
// field doesn't throw — it just means a booking saves with no
// vendorPayout and no way to pay the host. You find out weeks later when
// someone asks where their money is.
//
// The status enum is the other trap. markBookingPaid sets "paid", and if
// that's not listed Mongoose throws a ValidationError *after* Flutterwave
// has already charged the card.

import mongoose from "mongoose";

const bookingSchema = new mongoose.Schema(
  {
    // ── Who ──────────────────────────────────────────────────────────
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
      index: true,
    },
    ad: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ad",
      required: true,
      index: true,
    },

    // ── What ─────────────────────────────────────────────────────────
    // Snapshotted at booking time. A host renaming their listing
    // shouldn't rewrite history on a stay someone already paid for.
    propertyName: { type: String, required: true },
    propertyType: { type: String, default: "apartment" },

    // ── When ─────────────────────────────────────────────────────────
    checkIn: { type: Date, required: true },
    checkOut: { type: Date, required: true },
    nights: { type: Number, required: true },
    guests: { type: Number, default: 1 },

    // ── Money ────────────────────────────────────────────────────────
    // All computed server-side in priceStay(). The client sends dates and
    // a guest count; it never sends a price.
    nightlyRate: { type: Number, required: true },
    totalPrice: { type: Number, required: true },
    currency: { type: String, enum: ["GHS", "NGN"], default: "GHS" },
    commissionRate: { type: Number, default: 0.05 },
    commissionAmount: { type: Number, default: 0 },
    vendorPayout: { type: Number, default: 0 },

    // ── Status ───────────────────────────────────────────────────────
    // pending      guest hasn't paid
    // paid         money taken, host hasn't confirmed
    // confirmed    host accepted
    // checked_in   guest arrived — this is what releases escrow
    // checked_out  stay finished
    status: {
      type: String,
      enum: [
        "pending",
        "paid",
        "confirmed",
        "checked_in",
        "checked_out",
        "cancelled",
        "refunded",
      ],
      default: "pending",
      index: true,
    },

    // ── Escrow ───────────────────────────────────────────────────────
    // Held until the guest confirms check-in. If they never do, the host
    // marking check-out releases it — otherwise money sits frozen on a
    // stay that went perfectly well.
    escrowStatus: {
      type: String,
      enum: ["held", "released", "refunded", "disputed", "n/a"],
      default: "held",
    },
    escrowReleasedAt: Date,

    // ── Payment ──────────────────────────────────────────────────────
    // Fresh flwTxRef per attempt, so a failed payment can be retried
    // without colliding with the previous one.
    flwTxRef: { type: String, index: true },
    flwTxId: String,
    paidAt: Date,

    // ── Lifecycle ────────────────────────────────────────────────────
    checkedInAt: Date,
    checkedOutAt: Date,
    cancelledAt: Date,
    cancelledBy: { type: String, enum: ["guest", "vendor", "system"] },
    cancelReason: String,

    // ── Refund policy ────────────────────────────────────────────────
    // Snapshotted so a host changing their terms can't retroactively
    // affect a booking someone already made.
    //
    // The nested `type: { type: String }` isn't a mistake — Mongoose
    // reads a bare `type` key as a type declaration, so a field actually
    // called "type" has to be written this way.
    refundPolicy: {
      type: {
        type: String,
        enum: ["before_confirm", "window", "vendor_cancel", "none"],
        default: "before_confirm",
      },
      window: Number,
    },
    refundRequestedAt: Date,
    refundReason: String,
    refundNotes: String,

    // ── Timeline ─────────────────────────────────────────────────────
    // Append-only. A cancelled booking still shows it was confirmed
    // first, which is what support needs when something goes wrong.
    timeline: [
      {
        status: { type: String, required: true },
        label: String,
        note: String,
        actor: { type: String, enum: ["buyer", "vendor", "system", "admin"] },
        at: { type: Date, default: Date.now },
      },
    ],

    // Free-text from the guest at booking time
    notes: String,
  },
  { timestamps: true },
);

// ── Indexes ────────────────────────────────────────────────────────────

// The availability check runs on every booking creation and again at
// payment. Without this it's a collection scan, and under load two people
// can both pass before either writes — a double-booked property.
bookingSchema.index({ ad: 1, checkIn: 1, checkOut: 1 });

// The two list views
bookingSchema.index({ guest: 1, createdAt: -1 });
bookingSchema.index({ vendor: 1, createdAt: -1 });

// ── Virtuals ───────────────────────────────────────────────────────────

/** Short human reference: TXN-A1B2C3 */
bookingSchema.virtual("reference").get(function () {
  return `SB-${String(this._id).slice(-6).toUpperCase()}`;
});

/** True when the stay is in progress right now. */
bookingSchema.virtual("isActive").get(function () {
  const now = Date.now();
  return (
    ["confirmed", "checked_in"].includes(this.status) &&
    this.checkIn &&
    this.checkOut &&
    new Date(this.checkIn).getTime() <= now &&
    new Date(this.checkOut).getTime() >= now
  );
});

bookingSchema.set("toJSON", { virtuals: true });
bookingSchema.set("toObject", { virtuals: true });

export default mongoose.models.Booking ??
  mongoose.model("Booking", bookingSchema);
