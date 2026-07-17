// backend/scripts/migrate-orphan-promotions.js
//
// One-off cleanup for OLD promotion records that predate the current schema
// (missing userId, contactEmail, videoUrl, etc.). Without this, they'll
// live in the DB forever failing validation whenever anyone tries to save.
//
// Run with:
//   node scripts/migrate-orphan-promotions.js
//   node scripts/migrate-orphan-promotions.js --delete    # to hard-delete orphans instead of tagging
//   node scripts/migrate-orphan-promotions.js --dry-run   # to preview without changes

import "dotenv/config";
import mongoose from "mongoose";
import Promotion from "../models/promotion.js";

const isDelete = process.argv.includes("--delete");
const isDry = process.argv.includes("--dry-run");

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error("MONGO_URI env var required");
  process.exit(1);
}

await mongoose.connect(MONGO_URI);
console.log("Connected to MongoDB");

// Find records missing any of the newly-required fields
const orphans = await Promotion.find({
  $or: [
    { userId: { $exists: false } },
    { userId: null },
    { contactEmail: { $exists: false } },
    { contactEmail: null },
    { videoUrl: { $exists: false } },
    { videoUrl: null },
    { title: { $exists: false } },
    { title: null },
  ],
}).lean();

console.log(`Found ${orphans.length} orphan promotion(s)`);
if (orphans.length === 0) {
  console.log("Nothing to do. Exiting.");
  await mongoose.disconnect();
  process.exit(0);
}

for (const p of orphans) {
  const missing = [];
  if (!p.userId) missing.push("userId");
  if (!p.contactEmail) missing.push("contactEmail");
  if (!p.videoUrl) missing.push("videoUrl");
  if (!p.title) missing.push("title");
  console.log(
    `  · ${p._id}  missing: ${missing.join(", ")}  status: ${p.status}`,
  );
}

if (isDry) {
  console.log("\n--dry-run: no changes made.");
  await mongoose.disconnect();
  process.exit(0);
}

if (isDelete) {
  const ids = orphans.map((p) => p._id);
  const result = await Promotion.deleteMany({ _id: { $in: ids } });
  console.log(`\n🗑  Deleted ${result.deletedCount} orphan record(s).`);
} else {
  // Tag them as archived so they're excluded from queries but not lost
  const ids = orphans.map((p) => p._id);
  await Promotion.updateMany(
    { _id: { $in: ids } },
    {
      $set: {
        status: "expired",
        refundReason: "Legacy record — pre-schema migration",
      },
    },
    { runValidators: false },
  );
  console.log(
    `\n📦 Marked ${orphans.length} record(s) as expired (not deleted). Re-run with --delete to remove.`,
  );
}

await mongoose.disconnect();
process.exit(0);
