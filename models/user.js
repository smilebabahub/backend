import mongoose from "mongoose";

const subscriptionSchema = new mongoose.Schema({
  plan: {
    type: String,
    enum: ["basic", "standard", "premium"],
  },
  billingCycle: {
    type: String,
    enum: ["monthly", "yearly"],
  },

  price: Number,

  status: {
    type: String,
    enum: ["active", "expired", "cancelled"],
    default: "active",
  },

  startedAt: Date,
  expiresAt: Date,
});

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
    },

    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
    },

    password: {
      type: String,
    },

    phone: String,

    role: {
      type: String,
      enum: ["guest", "vendor", "admin"],
      default: "guest",
    },

    isSubscribed: {
      type: Boolean,
      default: false,
    },

    subscription: {
      type: subscriptionSchema,
      default: null,
    },
  },
  { timestamps: true },
);

export default mongoose.model("User", userSchema);
