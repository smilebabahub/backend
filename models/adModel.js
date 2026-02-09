import mongoose from "mongoose";

const adSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },

    category: {
      main: String,
      sub: String,
      type: String,
    },

    images: [
      {
        url: String,
        isCover: Boolean,
      },
    ],

    location: {
      region: String,
      city: String,
    },

    description: String,

    negotiable: {
      type: String,
      enum: ["yes", "no", "not_sure"],
      default: "not_sure",
    },

    price: Number,

    contact: {
      name: String,
      phone: String,
    },

    deliveryOption: String,

    subscription: {
      plan: {
        type: String,
        enum: ["daily", "weekly", "monthly"],
      },
      package: String,
      expiresAt: Date,
    },

    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
    },

    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true },
);

export default mongoose.model("Ad", adSchema);
