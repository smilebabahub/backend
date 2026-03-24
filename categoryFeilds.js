// seeds/03_category_fields.seed.js
// Run: node seeds/03_category_fields.seed.js
// Must run AFTER 02_categories.seed.js

import mongoose from "mongoose";

const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/marketplace";

// ── Schemas ────────────────────────────────────────────────────────────────
const categorySchema = new mongoose.Schema({ slug: String });
const Category =
  mongoose.models.Category || mongoose.model("Category", categorySchema);

const fieldSchema = new mongoose.Schema(
  {
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      required: true,
    },
    categorySlug: { type: String, required: true }, // denormalized for fast lookup
    fieldKey: { type: String, required: true },
    label: { type: String, required: true },
    fieldType: {
      type: String,
      enum: ["text", "number", "select", "multiselect", "boolean", "textarea"],
      required: true,
    },
    options: [{ type: String }], // for select / multiselect fields
    required: { type: Boolean, default: false },
    unit: { type: String, default: null }, // e.g. "km", "GHS", "nights"
    sortOrder: { type: Number, default: 0 }, // controls field render order in UI
  },
  { timestamps: true },
);

fieldSchema.index({ category: 1, fieldKey: 1 }, { unique: true });

const CategoryField =
  mongoose.models.CategoryField || mongoose.model("CategoryField", fieldSchema);

// ── Field definitions keyed by category slug ──────────────────────────────
// Each entry becomes N documents in category_fields
const fieldsByCategorySlug = {
  // ── Marketplace > Vehicles > Cars ─────────────────────────────────────
  cars: [
    {
      fieldKey: "brand",
      label: "Brand",
      fieldType: "select",
      required: true,
      sortOrder: 1,
      options: [
        "Toyota",
        "Honda",
        "Hyundai",
        "Kia",
        "Ford",
        "BMW",
        "Mercedes-Benz",
        "Nissan",
      ],
    },
    {
      fieldKey: "model",
      label: "Model",
      fieldType: "text",
      required: true,
      sortOrder: 2,
    },
    {
      fieldKey: "year",
      label: "Year",
      fieldType: "number",
      required: true,
      sortOrder: 3,
    },
    {
      fieldKey: "mileage",
      label: "Mileage",
      fieldType: "number",
      required: false,
      sortOrder: 4,
      unit: "km",
    },
    {
      fieldKey: "fuel",
      label: "Fuel Type",
      fieldType: "select",
      required: true,
      sortOrder: 5,
      options: ["Petrol", "Diesel", "Electric", "Hybrid", "LPG"],
    },
    {
      fieldKey: "transmission",
      label: "Transmission",
      fieldType: "select",
      required: true,
      sortOrder: 6,
      options: ["Automatic", "Manual"],
    },
    {
      fieldKey: "condition",
      label: "Condition",
      fieldType: "select",
      required: true,
      sortOrder: 7,
      options: ["Brand New", "Foreign Used", "Ghanaian Used"],
    },
    {
      fieldKey: "color",
      label: "Color",
      fieldType: "text",
      required: false,
      sortOrder: 8,
    },
  ],

  // ── Marketplace > Vehicles > Motorcycles ──────────────────────────────
  motorcycles: [
    {
      fieldKey: "brand",
      label: "Brand",
      fieldType: "select",
      required: true,
      sortOrder: 1,
      options: ["Honda", "Yamaha", "Suzuki", "Kawasaki"],
    },
    {
      fieldKey: "model",
      label: "Model",
      fieldType: "text",
      required: true,
      sortOrder: 2,
    },
    {
      fieldKey: "year",
      label: "Year",
      fieldType: "number",
      required: true,
      sortOrder: 3,
    },
    {
      fieldKey: "mileage",
      label: "Mileage",
      fieldType: "number",
      required: false,
      sortOrder: 4,
      unit: "km",
    },
    {
      fieldKey: "condition",
      label: "Condition",
      fieldType: "select",
      required: true,
      sortOrder: 5,
      options: ["Brand New", "Foreign Used", "Ghanaian Used"],
    },
  ],

  // ── Marketplace > Phones > Smartphones ───────────────────────────────
  smartphones: [
    {
      fieldKey: "brand",
      label: "Brand",
      fieldType: "select",
      required: true,
      sortOrder: 1,
      options: [
        "Apple",
        "Samsung",
        "Tecno",
        "Infinix",
        "Itel",
        "Xiaomi",
        "Huawei",
      ],
    },
    {
      fieldKey: "model",
      label: "Model",
      fieldType: "text",
      required: true,
      sortOrder: 2,
    },
    {
      fieldKey: "storage",
      label: "Storage",
      fieldType: "select",
      required: true,
      sortOrder: 3,
      options: ["16GB", "32GB", "64GB", "128GB", "256GB", "512GB", "1TB"],
    },
    {
      fieldKey: "ram",
      label: "RAM",
      fieldType: "select",
      required: true,
      sortOrder: 4,
      options: ["2GB", "3GB", "4GB", "6GB", "8GB", "12GB", "16GB"],
    },
    {
      fieldKey: "condition",
      label: "Condition",
      fieldType: "select",
      required: true,
      sortOrder: 5,
      options: ["Brand New", "Like New", "Good", "Fair"],
    },
    {
      fieldKey: "color",
      label: "Color",
      fieldType: "text",
      required: false,
      sortOrder: 6,
    },
  ],

  // ── Marketplace > Phones > Tablets ───────────────────────────────────
  tablets: [
    {
      fieldKey: "brand",
      label: "Brand",
      fieldType: "select",
      required: true,
      sortOrder: 1,
      options: ["Apple iPad", "Samsung", "Lenovo"],
    },
    {
      fieldKey: "model",
      label: "Model",
      fieldType: "text",
      required: true,
      sortOrder: 2,
    },
    {
      fieldKey: "storage",
      label: "Storage",
      fieldType: "select",
      required: true,
      sortOrder: 3,
      options: ["32GB", "64GB", "128GB", "256GB", "512GB"],
    },
    {
      fieldKey: "condition",
      label: "Condition",
      fieldType: "select",
      required: true,
      sortOrder: 4,
      options: ["Brand New", "Like New", "Good", "Fair"],
    },
  ],

  // ── Marketplace > Electronics ─────────────────────────────────────────
  laptops: [
    {
      fieldKey: "brand",
      label: "Brand",
      fieldType: "text",
      required: true,
      sortOrder: 1,
    },
    {
      fieldKey: "model",
      label: "Model",
      fieldType: "text",
      required: true,
      sortOrder: 2,
    },
    {
      fieldKey: "ram",
      label: "RAM",
      fieldType: "select",
      required: true,
      sortOrder: 3,
      options: ["4GB", "8GB", "16GB", "32GB", "64GB"],
    },
    {
      fieldKey: "storage",
      label: "Storage",
      fieldType: "select",
      required: true,
      sortOrder: 4,
      options: ["256GB SSD", "512GB SSD", "1TB SSD", "1TB HDD", "2TB HDD"],
    },
    {
      fieldKey: "condition",
      label: "Condition",
      fieldType: "select",
      required: true,
      sortOrder: 5,
      options: ["Brand New", "Like New", "Good", "Fair"],
    },
  ],
  televisions: [
    {
      fieldKey: "brand",
      label: "Brand",
      fieldType: "text",
      required: true,
      sortOrder: 1,
    },
    {
      fieldKey: "screen_size",
      label: "Screen Size",
      fieldType: "select",
      required: true,
      sortOrder: 2,
      options: ['24"', '32"', '40"', '43"', '50"', '55"', '65"', '75"'],
    },
    {
      fieldKey: "resolution",
      label: "Resolution",
      fieldType: "select",
      required: true,
      sortOrder: 3,
      options: ["HD", "Full HD", "4K", "8K"],
    },
    {
      fieldKey: "condition",
      label: "Condition",
      fieldType: "select",
      required: true,
      sortOrder: 4,
      options: ["Brand New", "Like New", "Good", "Fair"],
    },
  ],

  // ── Apartments (all apartment leaf slugs share these fields) ──────────
  studio: _apartmentFields(0),
  "1-bedroom": _apartmentFields(1),
  "2-bedroom": _apartmentFields(2),
  villa: _apartmentFields(3),
  "beach-house": _apartmentFields(4),
  "luxury-apartment": _apartmentFields(5),
  flat: _apartmentFields(6),
  duplex: _apartmentFields(7),
  townhouse: _apartmentFields(8),

  // ── Food leaf slugs ───────────────────────────────────────────────────
  "jollof-rice": _foodFields(),
  "fried-rice": _foodFields(),
  "plain-rice": _foodFields(),
  "chicken-noodles": _foodFields(),
  "beef-noodles": _foodFields(),
  "vegetable-noodles": _foodFields(),
  burger: _foodFields(),
  pizza: _foodFields(),
  sandwich: _foodFields(),
  cake: _foodFields(),
  "ice-cream": _foodFields(),
  pastries: _foodFields(),

  // ── Fashion ──────────────────────────────────────────────────────────
  "men-fashion": _fashionFields(),
  "women-fashion": _fashionFields(),
  "kids-fashion": _fashionFields(),

  // ── Services ──────────────────────────────────────────────────────────
  cleaning: _serviceFields(),
  plumbing: _serviceFields(),
  electrical: _serviceFields(),
  "event-services": _serviceFields(),
};

// ── Field template helpers ─────────────────────────────────────────────────
function _apartmentFields(/* ignored, just uniqueness */) {
  return [
    {
      fieldKey: "price_per_night",
      label: "Price per Night",
      fieldType: "number",
      required: true,
      sortOrder: 1,
      unit: "GHS",
    },
    {
      fieldKey: "bedrooms",
      label: "Bedrooms",
      fieldType: "number",
      required: true,
      sortOrder: 2,
    },
    {
      fieldKey: "bathrooms",
      label: "Bathrooms",
      fieldType: "number",
      required: true,
      sortOrder: 3,
    },
    {
      fieldKey: "max_guests",
      label: "Max Guests",
      fieldType: "number",
      required: true,
      sortOrder: 4,
    },
    {
      fieldKey: "amenities",
      label: "Amenities",
      fieldType: "multiselect",
      required: false,
      sortOrder: 5,
      options: [
        "WiFi",
        "Air Conditioning",
        "Swimming Pool",
        "Kitchen",
        "TV",
        "Generator",
        "Security",
        "Parking",
        "Gym",
        "Laundry",
      ],
    },
    {
      fieldKey: "furnished",
      label: "Furnished",
      fieldType: "boolean",
      required: false,
      sortOrder: 6,
    },
    {
      fieldKey: "pet_friendly",
      label: "Pet Friendly",
      fieldType: "boolean",
      required: false,
      sortOrder: 7,
    },
  ];
}

function _foodFields() {
  return [
    {
      fieldKey: "food_name",
      label: "Food Name",
      fieldType: "text",
      required: true,
      sortOrder: 1,
    },
    {
      fieldKey: "portion",
      label: "Portion Size",
      fieldType: "select",
      required: true,
      sortOrder: 2,
      options: ["Small", "Medium", "Large", "Family"],
    },
    {
      fieldKey: "ingredients",
      label: "Ingredients",
      fieldType: "textarea",
      required: false,
      sortOrder: 3,
    },
    {
      fieldKey: "delivery_time",
      label: "Delivery Time",
      fieldType: "select",
      required: false,
      sortOrder: 4,
      options: ["15–30 mins", "30–45 mins", "45–60 mins", "60+ mins"],
    },
    {
      fieldKey: "spice_level",
      label: "Spice Level",
      fieldType: "select",
      required: false,
      sortOrder: 5,
      options: ["No Spice", "Mild", "Medium", "Hot", "Extra Hot"],
    },
    {
      fieldKey: "is_vegetarian",
      label: "Vegetarian",
      fieldType: "boolean",
      required: false,
      sortOrder: 6,
    },
  ];
}

function _fashionFields() {
  return [
    {
      fieldKey: "brand",
      label: "Brand",
      fieldType: "text",
      required: false,
      sortOrder: 1,
    },
    {
      fieldKey: "size",
      label: "Size",
      fieldType: "select",
      required: true,
      sortOrder: 2,
      options: ["XS", "S", "M", "L", "XL", "XXL", "XXXL", "Custom"],
    },
    {
      fieldKey: "color",
      label: "Color",
      fieldType: "text",
      required: false,
      sortOrder: 3,
    },
    {
      fieldKey: "material",
      label: "Material",
      fieldType: "text",
      required: false,
      sortOrder: 4,
    },
    {
      fieldKey: "condition",
      label: "Condition",
      fieldType: "select",
      required: true,
      sortOrder: 5,
      options: ["Brand New", "Like New", "Good", "Fair"],
    },
  ];
}

function _serviceFields() {
  return [
    {
      fieldKey: "service_type",
      label: "Service Type",
      fieldType: "text",
      required: true,
      sortOrder: 1,
    },
    {
      fieldKey: "availability",
      label: "Availability",
      fieldType: "select",
      required: false,
      sortOrder: 2,
      options: ["Weekdays", "Weekends", "Anytime", "By Appointment"],
    },
    {
      fieldKey: "experience_yrs",
      label: "Years Experience",
      fieldType: "number",
      required: false,
      sortOrder: 3,
    },
    {
      fieldKey: "has_equipment",
      label: "Has Equipment",
      fieldType: "boolean",
      required: false,
      sortOrder: 4,
    },
  ];
}

// ── Seeder ─────────────────────────────────────────────────────────────────
async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log("🔌 Connected to MongoDB");

  await CategoryField.deleteMany({});
  console.log("🧹 Cleared category_fields collection");

  const slugs = Object.keys(fieldsByCategorySlug);
  const categories = await Category.find({ slug: { $in: slugs } }).lean();
  const categoryMap = Object.fromEntries(
    categories.map((c) => [c.slug, c._id]),
  );

  const docs = [];
  for (const [slug, fields] of Object.entries(fieldsByCategorySlug)) {
    const categoryId = categoryMap[slug];
    if (!categoryId) {
      console.warn(`⚠️  Category not found for slug: "${slug}" — skipping`);
      continue;
    }
    for (const field of fields) {
      docs.push({ ...field, category: categoryId, categorySlug: slug });
    }
  }

  const inserted = await CategoryField.insertMany(docs);
  console.log(
    `✅ Seeded ${inserted.length} category fields across ${slugs.length} categories`,
  );

  await mongoose.disconnect();
  console.log("🔒 Disconnected");
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
