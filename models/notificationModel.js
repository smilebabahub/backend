import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: [
        "subscription_expiring_7",
        "subscription_expiring_3",
        "subscription_expiring_1",
        "subscription_expired",
        "subscription_activated",
        "payment_failed",
        "boost_approved",
      ],
      required: true,
    },
    title: { type: String, required: true },
    message: { type: String, required: true },
    isRead: { type: Boolean, default: false },
    // For deep-linking — e.g. take user straight to /subscribe
    actionUrl: { type: String, default: null },
    actionLabel: { type: String, default: null },
    // Prevent duplicate notifications for the same event
    dedupeKey: { type: String, unique: true, sparse: true },
  },
  { timestamps: true },
);

// Index for fast unread counts per user
notificationSchema.index({ user: 1, isRead: 1 });

const Notification =
  mongoose.models.Notification ||
  mongoose.model("Notification", notificationSchema);

export default Notification;
