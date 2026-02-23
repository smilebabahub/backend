import mongoose from "mongoose";
import validator from "validator";
import bcrypt from "bcryptjs";

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
    // BASIC USER INFO

    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      minlength: 3,
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      validate: {
        validator: validator.isEmail,
        message: "Please provide a valid email",
      },
    },

    password: {
      type: String,
      required: true,
      minlength: 6,
    },

    profilePicture: {
      type: String, // Cloudinary or image URL
      default: "",
    },

    phone: {
      type: String,
      trim: true,
    },

    country: {
      type: String,
      trim: true,
    },
    city: {
      type: String,
    },

    // TRACKING INFO

    ipAddress: {
      type: String,
    },

    location: {
      type: String,
    },

    cartItems: [
      {
        product: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
        quantity: Number,
      },
    ],

    role: {
      type: String,
      enum: ["guest", "vendor", "admin"],
      default: "guest",
    },

    // VENDOR / STORE FIELDS
    // Required only if role = vendor

    storeName: {
      type: String,
      required: function () {
        return this.role === "vendor";
      },
    },

    storeLocation: {
      type: String,
      required: function () {
        return this.role === "vendor";
      },
    },

    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: function () {
        return this.role === "vendor";
      },
    },

    storeVideo: {
      type: String,
    },

    // SUBSCRIPTION

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
