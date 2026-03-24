// seeds/02_categories.seed.js
// Run: node seeds/02_categories.seed.js
// Must run AFTER 01_regions.seed.js

import mongoose from "mongoose";

const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/marketplace";

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    icon: { type: String, default: null },
    level: { type: Number, enum: [0, 1, 2], required: true }, // 0=root, 1=subcategory, 2=leaf
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      default: null,
    },
    // Denormalized path for easy ancestor querying e.g. "food > fast-food"
    path: { type: String, default: "" },
    brands: [{ type: String }], // only on leaf nodes that have brands (cars, phones)
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

const Category =
  mongoose.models.Category || mongoose.model("Category", categorySchema);

// Helper to generate slugs
const slugify = (str) =>
  str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log("🔌 Connected to MongoDB");

  await Category.deleteMany({});
  console.log("🧹 Cleared categories collection");

  // ── LEVEL 0: Root categories ──────────────────────────────────────────────
  const [food, apartments, marketplace] = await Category.insertMany([
    {
      name: "Food & Restaurants",
      slug: "food",
      icon: "food",
      level: 0,
      path: "food",
    },
    {
      name: "Apartments & Short Stays",
      slug: "apartments",
      icon: "home",
      level: 0,
      path: "apartments",
    },
    {
      name: "Marketplace",
      slug: "marketplace",
      icon: "shop",
      level: 0,
      path: "marketplace",
    },
  ]);
  console.log("✅ Root categories seeded");

  // ── LEVEL 1: Subcategories ────────────────────────────────────────────────
  const [riceDishes, noodles, fastFood, desserts] = await Category.insertMany([
    {
      name: "Rice Dishes",
      slug: "rice-dishes",
      level: 1,
      parent: food._id,
      path: "food > rice-dishes",
    },
    {
      name: "Noodles",
      slug: "noodles",
      level: 1,
      parent: food._id,
      path: "food > noodles",
    },
    {
      name: "Fast Food",
      slug: "fast-food",
      level: 1,
      parent: food._id,
      path: "food > fast-food",
    },
    {
      name: "Desserts",
      slug: "desserts",
      level: 1,
      parent: food._id,
      path: "food > desserts",
    },
  ]);

  const [shortStay, vacation, longTerm] = await Category.insertMany([
    {
      name: "Short Stay",
      slug: "short-stay",
      level: 1,
      parent: apartments._id,
      path: "apartments > short-stay",
    },
    {
      name: "Vacation Homes",
      slug: "vacation",
      level: 1,
      parent: apartments._id,
      path: "apartments > vacation",
    },
    {
      name: "Long Term Rentals",
      slug: "long-term",
      level: 1,
      parent: apartments._id,
      path: "apartments > long-term",
    },
  ]);

  const [vehicles, phones, electronics, fashion, services] =
    await Category.insertMany([
      {
        name: "Vehicles",
        slug: "vehicles",
        level: 1,
        parent: marketplace._id,
        path: "marketplace > vehicles",
      },
      {
        name: "Phones & Tablets",
        slug: "phones",
        level: 1,
        parent: marketplace._id,
        path: "marketplace > phones",
      },
      {
        name: "Electronics",
        slug: "electronics",
        level: 1,
        parent: marketplace._id,
        path: "marketplace > electronics",
      },
      {
        name: "Fashion",
        slug: "fashion",
        level: 1,
        parent: marketplace._id,
        path: "marketplace > fashion",
      },
      {
        name: "Services",
        slug: "services",
        level: 1,
        parent: marketplace._id,
        path: "marketplace > services",
      },
    ]);
  console.log("✅ Subcategories seeded");

  // ── LEVEL 2: Leaf categories ──────────────────────────────────────────────
  await Category.insertMany([
    // Food > Rice Dishes
    {
      name: "Jollof Rice",
      slug: "jollof-rice",
      level: 2,
      parent: riceDishes._id,
      path: "food > rice-dishes > jollof-rice",
    },
    {
      name: "Fried Rice",
      slug: "fried-rice",
      level: 2,
      parent: riceDishes._id,
      path: "food > rice-dishes > fried-rice",
    },
    {
      name: "Plain Rice",
      slug: "plain-rice",
      level: 2,
      parent: riceDishes._id,
      path: "food > rice-dishes > plain-rice",
    },

    // Food > Noodles
    {
      name: "Chicken Noodles",
      slug: "chicken-noodles",
      level: 2,
      parent: noodles._id,
      path: "food > noodles > chicken-noodles",
    },
    {
      name: "Beef Noodles",
      slug: "beef-noodles",
      level: 2,
      parent: noodles._id,
      path: "food > noodles > beef-noodles",
    },
    {
      name: "Vegetable Noodles",
      slug: "vegetable-noodles",
      level: 2,
      parent: noodles._id,
      path: "food > noodles > vegetable-noodles",
    },

    // Food > Fast Food
    {
      name: "Burger",
      slug: "burger",
      level: 2,
      parent: fastFood._id,
      path: "food > fast-food > burger",
    },
    {
      name: "Pizza",
      slug: "pizza",
      level: 2,
      parent: fastFood._id,
      path: "food > fast-food > pizza",
    },
    {
      name: "Sandwich",
      slug: "sandwich",
      level: 2,
      parent: fastFood._id,
      path: "food > fast-food > sandwich",
    },

    // Food > Desserts
    {
      name: "Cake",
      slug: "cake",
      level: 2,
      parent: desserts._id,
      path: "food > desserts > cake",
    },
    {
      name: "Ice Cream",
      slug: "ice-cream",
      level: 2,
      parent: desserts._id,
      path: "food > desserts > ice-cream",
    },
    {
      name: "Pastries",
      slug: "pastries",
      level: 2,
      parent: desserts._id,
      path: "food > desserts > pastries",
    },

    // Apartments > Short Stay
    {
      name: "Studio Apartment",
      slug: "studio",
      level: 2,
      parent: shortStay._id,
      path: "apartments > short-stay > studio",
    },
    {
      name: "1 Bedroom Apartment",
      slug: "1-bedroom",
      level: 2,
      parent: shortStay._id,
      path: "apartments > short-stay > 1-bedroom",
    },
    {
      name: "2 Bedroom Apartment",
      slug: "2-bedroom",
      level: 2,
      parent: shortStay._id,
      path: "apartments > short-stay > 2-bedroom",
    },

    // Apartments > Vacation
    {
      name: "Villa",
      slug: "villa",
      level: 2,
      parent: vacation._id,
      path: "apartments > vacation > villa",
    },
    {
      name: "Beach House",
      slug: "beach-house",
      level: 2,
      parent: vacation._id,
      path: "apartments > vacation > beach-house",
    },
    {
      name: "Luxury Apartment",
      slug: "luxury-apartment",
      level: 2,
      parent: vacation._id,
      path: "apartments > vacation > luxury-apartment",
    },

    // Apartments > Long Term
    {
      name: "Flat",
      slug: "flat",
      level: 2,
      parent: longTerm._id,
      path: "apartments > long-term > flat",
    },
    {
      name: "Duplex",
      slug: "duplex",
      level: 2,
      parent: longTerm._id,
      path: "apartments > long-term > duplex",
    },
    {
      name: "Townhouse",
      slug: "townhouse",
      level: 2,
      parent: longTerm._id,
      path: "apartments > long-term > townhouse",
    },

    // Marketplace > Vehicles
    {
      name: "Cars",
      slug: "cars",
      level: 2,
      parent: vehicles._id,
      path: "marketplace > vehicles > cars",
      brands: [
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
      name: "Motorcycles",
      slug: "motorcycles",
      level: 2,
      parent: vehicles._id,
      path: "marketplace > vehicles > motorcycles",
      brands: ["Honda", "Yamaha", "Suzuki", "Kawasaki"],
    },

    // Marketplace > Phones & Tablets
    {
      name: "Smartphones",
      slug: "smartphones",
      level: 2,
      parent: phones._id,
      path: "marketplace > phones > smartphones",
      brands: [
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
      name: "Tablets",
      slug: "tablets",
      level: 2,
      parent: phones._id,
      path: "marketplace > phones > tablets",
      brands: ["Apple iPad", "Samsung", "Lenovo"],
    },

    // Marketplace > Electronics
    {
      name: "Laptops",
      slug: "laptops",
      level: 2,
      parent: electronics._id,
      path: "marketplace > electronics > laptops",
    },
    {
      name: "Televisions",
      slug: "televisions",
      level: 2,
      parent: electronics._id,
      path: "marketplace > electronics > televisions",
    },
    {
      name: "Speakers",
      slug: "speakers",
      level: 2,
      parent: electronics._id,
      path: "marketplace > electronics > speakers",
    },
    {
      name: "Cameras",
      slug: "cameras",
      level: 2,
      parent: electronics._id,
      path: "marketplace > electronics > cameras",
    },

    // Marketplace > Fashion
    {
      name: "Men Fashion",
      slug: "men-fashion",
      level: 2,
      parent: fashion._id,
      path: "marketplace > fashion > men-fashion",
    },
    {
      name: "Women Fashion",
      slug: "women-fashion",
      level: 2,
      parent: fashion._id,
      path: "marketplace > fashion > women-fashion",
    },
    {
      name: "Kids Fashion",
      slug: "kids-fashion",
      level: 2,
      parent: fashion._id,
      path: "marketplace > fashion > kids-fashion",
    },

    // Marketplace > Services
    {
      name: "Cleaning Services",
      slug: "cleaning",
      level: 2,
      parent: services._id,
      path: "marketplace > services > cleaning",
    },
    {
      name: "Plumbing",
      slug: "plumbing",
      level: 2,
      parent: services._id,
      path: "marketplace > services > plumbing",
    },
    {
      name: "Electrical Work",
      slug: "electrical",
      level: 2,
      parent: services._id,
      path: "marketplace > services > electrical",
    },
    {
      name: "Event Services",
      slug: "event-services",
      level: 2,
      parent: services._id,
      path: "marketplace > services > event-services",
    },
  ]);
  console.log("✅ Leaf categories seeded");

  const total = await Category.countDocuments();
  console.log(`🎉 Total categories seeded: ${total}`);

  await mongoose.disconnect();
  console.log("🔒 Disconnected");
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
