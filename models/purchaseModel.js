import mongoose from "mongoose";

const purchaseSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // Flutterwave transaction reference
    txRef: { type: String, required: true, unique: true },
    transactionId: { type: String, default: null }, // FLW transaction ID after verification

    title: { type: String, required: true }, // Human-readable e.g. "happySmile Monthly Plan"
    planId: { type: String, required: true },
    billingCycle: { type: String, enum: ["monthly", "yearly"], required: true },

    amount: { type: Number, required: true },
    currency: { type: String, required: true }, // GHS | NGN

    status: {
      type: String,
      enum: ["pending", "successful", "failed"],
      default: "pending",
    },

    // Subscription period this payment covers
    periodStart: { type: Date, default: null },
    periodEnd: { type: Date, default: null },

    // Raw Flutterwave payload snapshot for audit
    gatewayMeta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true },
);

const Purchase =
  mongoose.models.Purchase || mongoose.model("Purchase", purchaseSchema);

export default Purchase;
