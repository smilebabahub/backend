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
  price: {
    type: Number,
  },
  startedAt: {
    type: Date,
  },
  expiresAt: {
    type: Date,
  },
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

    phone: {
      type: String,
    },

    role: {
      type: String,
      enum: ["guest", "registered"],
      default: "guest",
    },

    // Only registered users will have this filled, the guests will have null, please take note
    subscription: {
      type: subscriptionSchema,
      default: null,
    },
  },
  { timestamps: true },
);

const User = mongoose.model("User", userSchema);

export default User;
