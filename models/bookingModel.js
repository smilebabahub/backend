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
    propertyType: {
      type: String,
      enum: [
        "apartment",
        "villa",
        "studio",
        "duplex",
        "townhouse",
        "beach-house",
        "luxury-apartment",
        "short-stay",
      ],
      default: "apartment",
    },
    checkIn: { type: Date, required: true },
    checkOut: { type: Date, required: true },
    guests: { type: Number, default: 1, min: 1 },
    totalPrice: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ["GHS", "NGN"], default: "GHS" },
    status: {
      type: String,
      enum: ["pending", "confirmed", "checked_in", "checked_out", "cancelled"],
      default: "pending",
    },
    txRef: { type: String, default: null },
    notes: { type: String, default: "" },
  },
  { timestamps: true },
);

bookingSchema.index({ guest: 1, createdAt: -1 });
bookingSchema.index({ vendor: 1, createdAt: -1 });

export default mongoose.models.Booking ||
  mongoose.model("Booking", bookingSchema);
