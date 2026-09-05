// models/contactMessageModel.js
//
// A message from the contact form. Kept as a record rather than only
// emailed, so support can see what's outstanding and nothing gets lost
// in an inbox.

import mongoose from "mongoose";

const contactMessageSchema = new mongoose.Schema(
  {
    topic: { type: String, required: true },
    topicLabel: String,

    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    phone: String,

    /** An order, booking or transfer reference, when the topic has one */
    reference: String,

    message: { type: String, required: true },

    /** Set when the sender happened to be signed in */
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    status: {
      type: String,
      enum: ["new", "in_progress", "resolved", "spam"],
      default: "new",
      index: true,
    },
    handledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    handledAt: Date,
    internalNotes: String,

    ip: String,
  },
  { timestamps: true },
);

// The admin inbox view: oldest unhandled first
contactMessageSchema.index({ status: 1, createdAt: -1 });

export default mongoose.models.ContactMessage ??
  mongoose.model("ContactMessage", contactMessageSchema);
