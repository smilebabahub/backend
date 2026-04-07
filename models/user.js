// models/User.js
// Complete User model for SmileBaba Hub.
// Includes all vendor settings fields written by PATCH /auth/* endpoints.

import mongoose from "mongoose";

const { Schema } = mongoose;

// ── Sub-schemas ────────────────────────────────────────────────────────────

const subscriptionSchema = new Schema(
  {
    plan: { type: String, default: null },
    billingCycle: {
      type: String,
      enum: ["monthly", "yearly", "once", null],
      default: null,
    },
    price: { type: Number, default: 0 },
    currency: { type: String, default: null },
    startedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    referredBy: { type: Schema.Types.ObjectId, ref: "Marketer", default: null },
  },
  { _id: false },
);

const momoSchema = new Schema(
  {
    network: { type: String, default: "" },
    number: { type: String, default: "" },
    accountName: { type: String, default: "" },
  },
  { _id: false },
);

const bankSchema = new Schema(
  {
    bankName: { type: String, default: "" },
    accountNo: { type: String, default: "" },
    accountName: { type: String, default: "" },
    branch: { type: String, default: "" },
  },
  { _id: false },
);

const taxSchema = new Schema(
  {
    tin: { type: String, default: "" },
    vat: { type: String, default: "" },
    regNo: { type: String, default: "" },
  },
  { _id: false },
);

const scheduleSchema = new Schema(
  {
    frequency: {
      type: String,
      enum: ["daily", "weekly", "biweekly", "monthly"],
      default: "weekly",
    },
    minAmount: { type: String, default: "100" },
    currency: { type: String, default: "GHS" },
  },
  { _id: false },
);

const deliveryZoneSchema = new Schema(
  {
    zone: { type: String, required: true },
    eta: { type: String, default: "" },
    enabled: { type: Boolean, default: false },
  },
  { _id: false },
);

const deliveryPricingSchema = new Schema(
  {
    model: { type: String, default: "fixed" },
    baseFee: { type: String, default: "" },
    freeThreshold: { type: String, default: "" },
  },
  { _id: false },
);

const notificationsSchema = new Schema(
  {
    newOrder: { type: Boolean, default: true },
    orderStatus: { type: Boolean, default: true },
    newReview: { type: Boolean, default: true },
    newMessage: { type: Boolean, default: true },
    payoutSent: { type: Boolean, default: true },
    promotionApproved: { type: Boolean, default: true },
    weeklyReport: { type: Boolean, default: false },
    marketingTips: { type: Boolean, default: false },
    smsNewOrder: { type: Boolean, default: true },
    smsPayment: { type: Boolean, default: true },
    whatsappOrder: { type: Boolean, default: false },
  },
  { _id: false },
);

const promotionSchema = new Schema({
  title: { type: String, default: "" },
  description: { type: String, default: "" },
  category: { type: String, default: "" },
  promotionType: { type: String, default: "" },
  targetRegion: { type: String, default: "" },
  targetAudience: { type: String, default: "" },
  startDate: { type: String, default: "" },
  endDate: { type: String, default: "" },
  budget: { type: String, default: "" },
  currency: { type: String, default: "GHS" },
  contactName: { type: String, default: "" },
  contactPhone: { type: String, default: "" },
  contactEmail: { type: String, default: "" },
  preferredContact: { type: String, default: "phone" },
  videoUrl: { type: String, default: "" },
  videoName: { type: String, default: "" },
  status: {
    type: String,
    enum: ["pending", "approved", "rejected"],
    default: "pending",
  },
  submittedAt: { type: Date, default: Date.now },
  reviewedAt: { type: Date, default: null },
  reviewNote: { type: String, default: "" },
});

const operatingHoursSchema = new Schema(
  {
    open: { type: Boolean, default: true },
    from: { type: String, default: "08:00" },
    to: { type: String, default: "18:00" },
  },
  { _id: false },
);

// ── Main User schema ───────────────────────────────────────────────────────

const userSchema = new Schema(
  {
    // ── Auth ──────────────────────────────────────────────────────────────────
    username: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String, required: true },
    role: {
      type: String,
      enum: ["guest", "vendor", "admin"],
      default: "guest",
    },

    // ── Profile ───────────────────────────────────────────────────────────────
    profilePicture: { type: String, default: "" },
    phone: { type: String, default: "" },
    gender: {
      type: String,
      enum: ["male", "female", "other", ""],
      default: "",
    },
    dateOfBirth: { type: String, default: "" },
    bio: { type: String, default: "", maxlength: 300 },
    city: { type: String, default: "" },
    state: { type: String, default: "" }, // region (GH) or state (NG)
    country: { type: String, default: "Ghana" },
    currency: { type: String, default: "GHS" },

    // ── Store identity ─────────────────────────────────────────────────────────
    storeName: { type: String, default: "" },
    storeSlug: { type: String, default: "", lowercase: true, trim: true },
    storeCategory: { type: String, default: "" },
    storeDescription: { type: String, default: "" },
    storeEmail: { type: String, default: "" },
    storeWebsite: { type: String, default: "" },
    storePhone: { type: String, default: "" },
    storeBanner: { type: String, default: "" }, // Cloudinary URL
    storeLogo: { type: String, default: "" }, // Cloudinary URL
    businessType: {
      type: String,
      enum: ["individual", "registered", "enterprise", ""],
      default: "individual",
    },

    // ── Social ─────────────────────────────────────────────────────────────────
    instagram: { type: String, default: "" },
    facebook: { type: String, default: "" },
    whatsapp: { type: String, default: "" },

    // ── Store policies ─────────────────────────────────────────────────────────
    returnPolicy: { type: String, default: "" },
    deliveryPolicy: { type: String, default: "" },
    exchangePolicy: { type: String, default: "" },

    // ── Operating hours (Mon–Sun) ──────────────────────────────────────────────
    operatingHours: {
      Monday: { type: operatingHoursSchema, default: () => ({}) },
      Tuesday: { type: operatingHoursSchema, default: () => ({}) },
      Wednesday: { type: operatingHoursSchema, default: () => ({}) },
      Thursday: { type: operatingHoursSchema, default: () => ({}) },
      Friday: { type: operatingHoursSchema, default: () => ({}) },
      Saturday: {
        type: operatingHoursSchema,
        default: () => ({ open: false }),
      },
      Sunday: { type: operatingHoursSchema, default: () => ({ open: false }) },
    },

    // ── Subscription ───────────────────────────────────────────────────────────
    subscription: { type: subscriptionSchema, default: () => ({}) },

    // ── Payout / payments ──────────────────────────────────────────────────────
    payoutMethod: {
      type: String,
      enum: ["momo", "bank", "both", ""],
      default: "momo",
    },
    momoDetails: { type: momoSchema, default: () => ({}) },
    bankDetails: { type: bankSchema, default: () => ({}) },
    taxInfo: { type: taxSchema, default: () => ({}) },
    payoutSchedule: { type: scheduleSchema, default: () => ({}) },

    // ── Shipping ────────────────────────────────────────────────────────────────
    deliveryZones: { type: [deliveryZoneSchema], default: [] },
    deliveryPricing: { type: deliveryPricingSchema, default: () => ({}) },
    dispatchTime: { type: String, default: "24" },
    packagingNotes: { type: String, default: "" },

    // ── KYC ────────────────────────────────────────────────────────────────────
    kycStatus: {
      identity: {
        type: String,
        enum: ["not_submitted", "pending", "verified"],
        default: "not_submitted",
      },
      business: {
        type: String,
        enum: ["not_submitted", "pending", "verified"],
        default: "not_submitted",
      },
      payment: {
        type: String,
        enum: ["not_submitted", "pending", "verified"],
        default: "not_submitted",
      },
    },
    kycDocType: { type: String, default: "" },
    kycDocNumber: { type: String, default: "" },
    kycDocExpiry: { type: String, default: "" },
    kycFrontUrl: { type: String, default: "" },
    kycBackUrl: { type: String, default: "" },
    kycBizUrl: { type: String, default: "" },
    kycBizRegNo: { type: String, default: "" },

    // ── Notifications ──────────────────────────────────────────────────────────
    notifications: { type: notificationsSchema, default: () => ({}) },

    // ── Promotions ─────────────────────────────────────────────────────────────
    promotions: { type: [promotionSchema], default: [] },

    // ── Auth internals ─────────────────────────────────────────────────────────
    refreshToken: { type: String, default: null },
    loginHistory: { type: Array, default: [] },
    resetToken: { type: String, default: null },
    resetExpires: { type: Date, default: null },
    isActive: { type: Boolean, default: true },
  },
  {
    timestamps: true,
    // Allow fields not listed above to be saved — important for backwards
    // compatibility as we add new vendor settings fields over time.
    strict: false,
  },
);

// ── Indexes ────────────────────────────────────────────────────────────────
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ role: 1 });
userSchema.index({ country: 1 });
userSchema.index({ storeSlug: 1 }, { sparse: true });
userSchema.index({ createdAt: -1 });

// ── Export ─────────────────────────────────────────────────────────────────
export default mongoose.models.User || mongoose.model("User", userSchema);
