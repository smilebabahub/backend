// models/order.js
import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    qty: { type: Number, required: true, min: 1 },
    price: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const orderSchema = new mongoose.Schema(
  {
    buyer: {
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
    items: { type: [orderItemSchema], required: true },
    total: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ["GHS", "NGN"], default: "GHS" },
    status: {
      type: String,
      enum: ["pending", "confirmed", "dispatched", "delivered", "cancelled"],
      default: "pending",
    },
    deliveryAddress: { type: String, default: "" },
    txRef: { type: String, default: null },
    notes: { type: String, default: "" },
    // Commission tracking
    commissionRate: { type: Number, default: 0.05 },
    commissionAmount: { type: Number, required: true },
    vendorPayout: { type: Number, required: true },

    // Escrow state (for physical goods, apartments, services)
    escrowStatus: {
      type: String,
      enum: ["held", "released", "refunded", "disputed", "n/a"],
      default: "held",
    },
    escrowReleaseTrigger: {
      type: String,
      enum: [
        "auto_on_delivery",
        "buyer_confirms",
        "vendor_confirms_delivery",
        "manual",
      ],
      default: "buyer_confirms",
    },
    escrowReleasedAt: Date,

    // Payment model (differs by category)
    paymentModel: {
      type: String,
      enum: ["escrow", "split_at_source"],
      required: true,
    },

    // Refund policy snapshot — taken at order time so future policy changes don't apply retroactively
    refundPolicy: {
      type: {
        type: String,
        enum: ["none", "before_dispatch", "vendor_cancel", "window"],
      },
      window: Number, // days, only for type=window
    },
    refundEligible: { type: Boolean, default: true }, // computed based on policy + current state
    refundRequestedAt: Date,
    refundReason: String,
    refundNotes: String,

    // Delivery confirmation
    deliveryConfirmedAt: Date,
    deliveryConfirmedBy: {
      type: String,
      enum: ["buyer", "vendor", "system", "admin"],
    },
    orderGroup: { type: String, index: true },
    deliveryFee: { type: Number, default: 0 },

    // Flutterwave references
    flwTxRef: String, // Your reference (order._id or generated)
    flwTxId: String, // Flutterwave's transaction ID
    flwFlowType: String, // "escrow" or "split"
    flwSubaccountId: String, // For split_at_source — vendor's subaccount
  },

  { timestamps: true },
);

orderSchema.index({ buyer: 1, createdAt: -1 });
orderSchema.index({ vendor: 1, createdAt: -1 });

export default mongoose.models.Order || mongoose.model("Order", orderSchema);
