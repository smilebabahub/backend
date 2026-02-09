import mongoose from "mongoose";

const productSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },

    description: String,

    price: { type: Number, required: true },

    images: [
      {
        url: String,
        isCover: Boolean,
      },
    ],

    stock: {
      type: Number,
      default: 1,
    },

    vendor: {
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

export default mongoose.model("Product", productSchema);
