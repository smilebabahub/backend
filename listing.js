// seeds/04_listings.seed.js
// Run: node seeds/04_listings.seed.js
// Must run AFTER 01, 02, 03 seeds

import mongoose from "mongoose";

const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/marketplace";

// ── Schemas ────────────────────────────────────────────────────────────────
const categorySchema = new mongoose.Schema({ slug: String, name: String });
const Category =
  mongoose.models.Category || mongoose.model("Category", categorySchema);

const regionSchema = new mongoose.Schema({ slug: String, name: String });
const Region = mongoose.models.Region || mongoose.model("Region", regionSchema);

const listingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },

    // Price — stored flat for fast sorting/filtering
    price: { type: Number, required: true },
    priceUnit: { type: String, default: "GHS" }, // GHS, per night, per portion, etc.

    status: {
      type: String,
      enum: ["active", "pending", "sold", "paused"],
      default: "active",
    },

    // Category refs (all three levels stored for query flexibility)
    rootCategory: { type: mongoose.Schema.Types.ObjectId, ref: "Category" },
    subCategory: { type: mongoose.Schema.Types.ObjectId, ref: "Category" },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    categorySlug: { type: String, required: true }, // denormalized

    region: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Region",
      required: true,
    },
    regionName: { type: String }, // denormalized
    city: { type: String },

    // EAV: dynamic attributes per category (replaces 1-table-per-category)
    // e.g. [{ key: "brand", value: "Toyota" }, { key: "year", value: "2019" }]
    attributes: [
      {
        key: { type: String, required: true },
        value: { type: mongoose.Schema.Types.Mixed, required: true },
        _id: false,
      },
    ],

    // Media
    images: [{ url: String, position: Number }],

    // Seller (stub — replace with real user ObjectId in production)
    seller: {
      name: { type: String },
      phone: { type: String },
    },

    views: { type: Number, default: 0 },
    isFeatured: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Useful indexes
listingSchema.index({ categorySlug: 1, status: 1 });
listingSchema.index({ "attributes.key": 1, "attributes.value": 1 });
listingSchema.index({ price: 1 });
listingSchema.index({ region: 1 });

const Listing =
  mongoose.models.Listing || mongoose.model("Listing", listingSchema);

// ── Sample listings ────────────────────────────────────────────────────────
async function buildSamples(catMap, regMap) {
  return [
    // ── Car listing ──────────────────────────────────────────────────────
    {
      title: "2019 Toyota Camry - Excellent Condition",
      description:
        "Well-maintained foreign used Toyota Camry with full AC and leather seats.",
      price: 85000,
      priceUnit: "GHS",
      rootCategory: catMap["marketplace"],
      subCategory: catMap["vehicles"],
      category: catMap["cars"],
      categorySlug: "cars",
      region: regMap["ashanti"],
      regionName: "Ashanti",
      city: "Kumasi Metropolitan",
      attributes: [
        { key: "brand", value: "Toyota" },
        { key: "model", value: "Camry" },
        { key: "year", value: 2019 },
        { key: "mileage", value: 62000 },
        { key: "fuel", value: "Petrol" },
        { key: "transmission", value: "Automatic" },
        { key: "condition", value: "Foreign Used" },
        { key: "color", value: "Silver" },
      ],
      images: [
        {
          url: "https://placeholder.co/800x600?text=Toyota+Camry",
          position: 0,
        },
      ],
      seller: { name: "Kwame Asante", phone: "0244123456" },
    },

    // ── Motorcycle listing ───────────────────────────────────────────────
    {
      title: "Honda CB150 - Brand New",
      description:
        "Brand new Honda CB150 with warranty. Perfect for city commuting.",
      price: 9500,
      priceUnit: "GHS",
      rootCategory: catMap["marketplace"],
      subCategory: catMap["vehicles"],
      category: catMap["motorcycles"],
      categorySlug: "motorcycles",
      region: regMap["greater-accra"],
      regionName: "Greater Accra",
      city: "Tema",
      attributes: [
        { key: "brand", value: "Honda" },
        { key: "model", value: "CB150" },
        { key: "year", value: 2024 },
        { key: "mileage", value: 0 },
        { key: "condition", value: "Brand New" },
      ],
      images: [
        { url: "https://placeholder.co/800x600?text=Honda+CB150", position: 0 },
      ],
      seller: { name: "Moto Ghana Ltd", phone: "0302456789" },
    },

    // ── Smartphone listing ───────────────────────────────────────────────
    {
      title: "iPhone 15 Pro Max 256GB - Like New",
      description:
        "Used for 3 months only. Comes with original box, charger and case.",
      price: 8200,
      priceUnit: "GHS",
      rootCategory: catMap["marketplace"],
      subCategory: catMap["phones"],
      category: catMap["smartphones"],
      categorySlug: "smartphones",
      region: regMap["greater-accra"],
      regionName: "Greater Accra",
      city: "Accra Metropolitan",
      attributes: [
        { key: "brand", value: "Apple" },
        { key: "model", value: "iPhone 15 Pro Max" },
        { key: "storage", value: "256GB" },
        { key: "ram", value: "8GB" },
        { key: "condition", value: "Like New" },
        { key: "color", value: "Natural Titanium" },
      ],
      images: [
        {
          url: "https://placeholder.co/800x600?text=iPhone+15+Pro+Max",
          position: 0,
        },
      ],
      seller: { name: "Ama Boateng", phone: "0551987654" },
    },

    // ── Apartment listing ────────────────────────────────────────────────
    {
      title: "Cozy 2BR Apartment in East Legon - Short Stay",
      description:
        "Fully furnished 2 bedroom apartment. Fast WiFi, generator, 24hr security.",
      price: 350,
      priceUnit: "GHS/night",
      rootCategory: catMap["apartments"],
      subCategory: catMap["short-stay"],
      category: catMap["2-bedroom"],
      categorySlug: "2-bedroom",
      region: regMap["greater-accra"],
      regionName: "Greater Accra",
      city: "Accra Metropolitan",
      attributes: [
        { key: "price_per_night", value: 350 },
        { key: "bedrooms", value: 2 },
        { key: "bathrooms", value: 2 },
        { key: "max_guests", value: 4 },
        {
          key: "amenities",
          value: [
            "WiFi",
            "Air Conditioning",
            "TV",
            "Generator",
            "Security",
            "Parking",
          ],
        },
        { key: "furnished", value: true },
        { key: "pet_friendly", value: false },
      ],
      images: [
        {
          url: "https://placeholder.co/800x600?text=2BR+Apartment",
          position: 0,
        },
      ],
      seller: { name: "Prime Stays GH", phone: "0244987123" },
    },

    // ── Food listing ─────────────────────────────────────────────────────
    {
      title: "Special Jollof Rice with Chicken",
      description:
        "Smoky party jollof rice with fried chicken, salad and plantain.",
      price: 45,
      priceUnit: "GHS",
      rootCategory: catMap["food"],
      subCategory: catMap["rice-dishes"],
      category: catMap["jollof-rice"],
      categorySlug: "jollof-rice",
      region: regMap["ashanti"],
      regionName: "Ashanti",
      city: "Kumasi Metropolitan",
      attributes: [
        { key: "food_name", value: "Jollof Rice with Chicken" },
        { key: "portion", value: "Large" },
        {
          key: "ingredients",
          value: "Rice, tomatoes, pepper, chicken, onions, spices",
        },
        { key: "delivery_time", value: "30–45 mins" },
        { key: "spice_level", value: "Medium" },
        { key: "is_vegetarian", value: false },
      ],
      images: [
        { url: "https://placeholder.co/800x600?text=Jollof+Rice", position: 0 },
      ],
      seller: { name: "Mama's Kitchen Kumasi", phone: "0277345678" },
    },

    // ── Fashion listing ──────────────────────────────────────────────────
    {
      title: "Kente Agbada Set - Brand New",
      description:
        "Handwoven Kente fabric Agbada set. 3-piece: top, trousers, cap. Size XL.",
      price: 650,
      priceUnit: "GHS",
      rootCategory: catMap["marketplace"],
      subCategory: catMap["fashion"],
      category: catMap["men-fashion"],
      categorySlug: "men-fashion",
      region: regMap["ashanti"],
      regionName: "Ashanti",
      city: "Kumasi Metropolitan",
      attributes: [
        { key: "brand", value: "Local Artisan" },
        { key: "size", value: "XL" },
        { key: "color", value: "Multi-color Kente" },
        { key: "material", value: "Kente Fabric" },
        { key: "condition", value: "Brand New" },
      ],
      images: [
        {
          url: "https://placeholder.co/800x600?text=Kente+Agbada",
          position: 0,
        },
      ],
      seller: { name: "Kente House Kumasi", phone: "0241567890" },
    },
  ];
}

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log("🔌 Connected to MongoDB");

  await Listing.deleteMany({});
  console.log("🧹 Cleared listings collection");

  // Build lookup maps by slug
  const categories = await Category.find({}).lean();
  const catMap = Object.fromEntries(categories.map((c) => [c.slug, c._id]));

  const regions = await Region.find({}).lean();
  // regMap supports both prefixed slugs (gh-ashanti) and shorthand (ashanti → gh-ashanti)
  const regMap = Object.fromEntries([
    ...regions.map((r) => [r.slug, r._id]),
    ...regions
      .filter((r) => r.countryCode === "GH")
      .map((r) => [r.slug.replace("gh-", ""), r._id]),
    ...regions
      .filter((r) => r.countryCode === "NG")
      .map((r) => [r.slug.replace("ng-", ""), r._id]),
  ]);

  const samples = await buildSamples(catMap, regMap);
  const inserted = await Listing.insertMany(samples);
  console.log(`✅ Seeded ${inserted.length} sample listings`);

  await mongoose.disconnect();
  console.log("🔒 Disconnected");
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
