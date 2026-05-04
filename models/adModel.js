// models/ad.js
import mongoose from "mongoose";

// ── Sub-schemas ────────────────────────────────────────────────────────────

const imageSchema = new mongoose.Schema(
  {
    url:      { type: String, required: true },
    isCover:  { type: Boolean, default: false },
    publicId: { type: String, default: null }, // Cloudinary public_id for deletion
  },
  { _id: false }
);

const locationSchema = new mongoose.Schema(
  {
    country:     { type: String, enum: ["Ghana", "Nigeria"], required: true },
    countryCode: { type: String, enum: ["GH", "NG"],        required: true },
    region:      { type: String, required: true }, // e.g. "Greater Accra" / "Lagos"
    regionSlug:  { type: String },                 // e.g. "gh-greater-accra"
    city:        { type: String },                 // e.g. "Tema"
    address:     { type: String },                 // optional street address
    coordinates: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
    },
  },
  { _id: false }
);

const contactSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true },
    phone:       { type: String, required: true },
    whatsapp:    { type: String, default: null },   // separate WhatsApp number if different
    showPhone:   { type: Boolean, default: true },  // vendor can hide phone from listing
  },
  { _id: false }
);

const categorySchema = new mongoose.Schema(
  {
    main:     { type: String, required: true },  // "marketplace" | "food" | "apartments"
    sub:      { type: String },                  // e.g. "vehicles" | "electronics"
    leaf:     { type: String },                  // e.g. "cars" | "smartphones"
    // Denormalised path for easy breadcrumb rendering
    path:     { type: String },                  // e.g. "marketplace > vehicles > cars"
  },
  { _id: false }
);

// Dynamic attributes — replaces the EAV pattern from listing_attributes
// e.g. [{ key: "brand", value: "Toyota" }, { key: "year", value: 2019 }]
const attributeSchema = new mongoose.Schema(
  {
    key:   { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { _id: false }
);

const boostSchema = new mongoose.Schema(
  {
    isBoosted:   { type: Boolean, default: false },
    boostedAt:   { type: Date,    default: null  },
    boostedUntil:{ type: Date,    default: null  },
    boostTier:   {
      type:    String,
      enum:    ["standard", "featured", "premium"],
      default: "standard",
    },
  },
  { _id: false }
);

const adSubscriptionSchema = new mongoose.Schema(
  {
    plan:      { type: String, enum: ["Basic", "standard", "popular", "premium"] },
    package:   { type: String },   // human-readable plan name e.g. "HappySmile"
    // Numeric tier 0–3 for fast sort: premium=3, popular=2, standard=1, Basic=0
    // Stored on the ad so sorting never requires a $lookup on the User collection.
    planPriority: { type: Number, default: 0 },
    startedAt: { type: Date },
    expiresAt: { type: Date },
    // Listing duration determined by the vendor's subscription plan
    listingDays: { type: Number, default: 30 },
  },
  { _id: false }
);

const moderationSchema = new mongoose.Schema(
  {
    status: {
      type:    String,
      enum:    ["pending", "approved", "rejected", "flagged"],
      default: "approved",
    },
    reviewedBy:  { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt:  { type: Date,   default: null },
    rejectReason:{ type: String, default: null },
  },
  { _id: false }
);

// ── Main Ad schema ─────────────────────────────────────────────────────────
const adSchema = new mongoose.Schema(
  {
    // ── Core ─────────────────────────────────────────────────────────────
    title:       { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 5000 },
    slug:        { type: String, unique: true, sparse: true }, // SEO-friendly URL

    // ── Category ─────────────────────────────────────────────────────────
    category: categorySchema,

    // ── Media ────────────────────────────────────────────────────────────
    images: {
      type:     [imageSchema],
      validate: {
        validator: (imgs) => imgs.length <= 10,
        message:   "Maximum 10 images per ad",
      },
    },
    videoUrl: { type: String, default: null }, // optional product video

    // ── Pricing ──────────────────────────────────────────────────────────
    price: {
      amount:   { type: Number, required: true, min: 0 },
      currency: { type: String, enum: ["GHS", "NGN"], required: true },
      // Formatted string cached for display: "₵ 1,200"
      display:  { type: String },
    },
    negotiable: {
      type:    String,
      enum:    ["yes", "no", "not_sure"],
      default: "not_sure",
    },

    // ── Dynamic category-specific attributes ─────────────────────────────
    // e.g. cars: brand, year, mileage | phones: storage, ram | food: portion, spice
    attributes: [attributeSchema],

    // ── Location ─────────────────────────────────────────────────────────
    location: { type: locationSchema, required: true },

    // ── Contact ──────────────────────────────────────────────────────────
    contact: { type: contactSchema, required: true },

    // ── Delivery ─────────────────────────────────────────────────────────
    delivery: {
      available: { type: Boolean, default: false },
      option:    {
        type: String,
        enum: ["pickup_only", "delivery_only", "both"],
        default: "pickup_only",
      },
      fee:       { type: Number, default: 0 },
      feeCurrency: { type: String, enum: ["GHS", "NGN", "free"], default: "free" },
      note:      { type: String, default: null }, // e.g. "Free delivery within Accra"
    },

    // ── Condition (for physical goods) ───────────────────────────────────
    condition: {
      type: String,
      enum: ["brand_new", "foreign_used", "local_used", "refurbished", "not_applicable"],
      default: "not_applicable",
    },

    // ── Vendor subscription details ───────────────────────────────────────
    subscription: adSubscriptionSchema,

    // ── Boost ────────────────────────────────────────────────────────────
    boost: { type: boostSchema, default: () => ({}) },

    // ── Moderation ───────────────────────────────────────────────────────
    moderation: { type: moderationSchema, default: () => ({}) },

    // ── Ownership ────────────────────────────────────────────────────────
    postedBy: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "User",
      required: true,
      index:    true,
    },
    referredBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "Marketer",
      default: null,
    },

    // ── Status & visibility ───────────────────────────────────────────────
    isActive:  { type: Boolean, default: true,  index: true },
    isSold:    { type: Boolean, default: false },
    isPaused:  { type: Boolean, default: false },  // vendor paused (not expired)
    isFeatured:{ type: Boolean, default: false },  // admin-featured on homepage

    // ── Analytics ────────────────────────────────────────────────────────
    views:      { type: Number, default: 0 },
    saves:      { type: Number, default: 0 }, // users who saved/bookmarked this ad
    shares:     { type: Number, default: 0 },
    contactClicks: { type: Number, default: 0 }, // times phone/whatsapp was tapped

    // ── Tags (for search) ─────────────────────────────────────────────────
    tags: [{ type: String, lowercase: true, trim: true }],

    // ── Expiry (from subscription plan) ──────────────────────────────────
    expiresAt: { type: Date, index: true },
  },
  {
    timestamps: true, // createdAt, updatedAt
    toJSON:     { virtuals: true },
    toObject:   { virtuals: true },
  }
);

// ── Virtuals ───────────────────────────────────────────────────────────────
adSchema.virtual("isExpired").get(function () {
  if (!this.expiresAt) return false;
  return new Date(this.expiresAt) < new Date();
});

adSchema.virtual("coverImage").get(function () {
  if (!this.images?.length) return null;
  return this.images.find((img) => img.isCover)?.url ?? this.images[0]?.url ?? null;
});

adSchema.virtual("daysLeft").get(function () {
  if (!this.expiresAt) return null;
  const diff = new Date(this.expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / 86400000));
});

// ── Indexes ────────────────────────────────────────────────────────────────
// Compound indexes for the most common query patterns
adSchema.index({ "location.country": 1, isActive: 1, expiresAt: 1 });
adSchema.index({ "location.country": 1, "subscription.planPriority": -1, "boost.isBoosted": -1, createdAt: -1 });
adSchema.index({ "category.main": 1, "location.country": 1, isActive: 1 });
adSchema.index({ "category.leaf": 1, isActive: 1 });
adSchema.index({ "price.amount": 1 });
adSchema.index({ "boost.isBoosted": 1, "boost.boostedUntil": 1 });
adSchema.index({ "attributes.key": 1, "attributes.value": 1 });
adSchema.index({ createdAt: -1 });
adSchema.index({ tags: 1 });
// Text search index for title + description
adSchema.index(
  { title: "text", description: "text", tags: "text" },
  { weights: { title: 10, tags: 5, description: 1 }, name: "AdTextSearch" }
);

// ── Pre-save hooks ─────────────────────────────────────────────────────────
adSchema.pre("save", async function () {
  // Auto-generate slug from title if not set
  if (!this.slug && this.title) {
    const base  = this.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const short = String(this._id).slice(-5);
    this.slug   = `${base}-${short}`;
  }

  // Cache formatted price display string
  if (this.price?.amount !== undefined && this.price?.currency) {
    const sym = this.price.currency === "NGN" ? "₦" : "₵";
    this.price.display = `${sym}${Number(this.price.amount).toLocaleString()}`;
  }

  // Sync top-level expiresAt with subscription.expiresAt for the index
  if (this.subscription?.expiresAt) {
    this.expiresAt = this.subscription.expiresAt;
  }
});

// ── Model ─────────────────────────────────────────────────────────────────
const Ad = mongoose.models.Ad || mongoose.model("Ad", adSchema);
export default Ad;