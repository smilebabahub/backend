import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    tx_ref: {
      type: String,
      required: true,
      unique: true,
    },

    transaction_id: String,

    amount: Number,

    currency: {
      type: String,
      default: "GHS",
    },

    status: {
      type: String,
      enum: ["pending", "successful", "failed"],
      default: "pending",
    },
  },
  { timestamps: true },
);

export default mongoose.model("payment", paymentSchema);
