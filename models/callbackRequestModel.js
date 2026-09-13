// ═══════════════════════════════════════════════════════════════════════
// models/callbackRequestModel.js — NEW FILE
// ═══════════════════════════════════════════════════════════════════════


import mongoose from "mongoose";
 
const callbackRequestSchema = new mongoose.Schema(
  {
    ad:     { type: mongoose.Schema.Types.ObjectId, ref: "Ad", required: true, index: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
 
    // Set when the asker happened to be signed in. Most won't be — the
    // point of a callback is not having to make an account.
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
 
    name:    { type: String, required: true },
    phone:   { type: String, required: true, index: true },
    message: String,
 
    // Snapshotted, so the request still reads properly after the listing
    // is edited, sold or deleted
    adTitle: String,
 
    status: {
      type: String,
      enum: ["new", "called", "no_answer", "closed"],
      default: "new",
      index: true,
    },
    calledAt:   Date,
    vendorNote: String,
 
    ip: String,
  },
  { timestamps: true },
);


// The vendor's inbox: newest first, unanswered first
callbackRequestSchema.index({ vendor: 1, status: 1, createdAt: -1 });
 
// Rate limiting reads this
callbackRequestSchema.index({ ad: 1, phone: 1, createdAt: -1 });
 
export default mongoose.models.CallbackRequest ??
  mongoose.model("CallbackRequest", callbackRequestSchema);