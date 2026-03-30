// models/chatModel.js
import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    room: { type: String, required: true, index: true },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    receiver: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    text: { type: String, required: true, maxlength: 5000 },

    // Attachment (image / file URL from Cloudinary)
    attachment: {
      url: { type: String, default: null },
      type: { type: String, enum: ["image", "file", null], default: null },
      name: { type: String, default: null },
    },

    edited: { type: Boolean, default: false },
    deleted: { type: Boolean, default: false }, // deleted for everyone
    deletedFor: [{ type: String }], // user IDs who soft-deleted for themselves

    // Read receipt
    readBy: [{ type: String }], // array of userId strings who have read it
  },
  { timestamps: true },
);

// Compound index for fast room history fetch
messageSchema.index({ room: 1, createdAt: -1 });

export default mongoose.models?.Message ??
  mongoose.model("Message", messageSchema);
