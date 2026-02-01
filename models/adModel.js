import mongoose from "mongoose"

const adSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },

    category: {
      main: { type: String, required: true }, // vehicles
      sub: { type: String, required: true }, // cars
      type: { type: String }, // Toyota
    },

    images: [
      {
        url: String,
        isCover: Boolean,
      },
    ],

    location: {
      region: { type: String, required: true }, // Greater Accra
      city: { type: String, required: true }, // Madina
    },

    description: {
      type: String,
      required: true,
    },

    negotiable: {
      type: String,
      enum: ["yes", "no", "not_sure"],
      default: "not_sure",
    },

    price: {
      type: Number,
      required: true,
    },

    contact: {
      name: { type: String, required: true },
      phone: { type: String, required: true },
    },

    deliveryOption: {
      type: String,
    },

    subscription: {
      plan: {
        type: String,
        enum: ["daily", "weekly", "monthly"],
        required: true,
      },
      package: {
        type: String, // basic | standard | premium
        required: true,
      },
      expiresAt: Date,
    },

    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

const add = mongoose.model("Ad", adSchema);
export default add;