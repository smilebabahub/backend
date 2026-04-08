// scripts/cleanPendingPurchases.js
// One-time cleanup of all stale pending Purchase records.
// Safe to run multiple times — only touches status:"pending" records.
//
// Run: node scripts/cleanPendingPurchases.js

import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

await mongoose.connect(process.env.MONGO_URI);
console.log("✓ Connected\n");

const Purchase = mongoose.model(
  "Purchase",
  new mongoose.Schema({}, { strict: false }),
);

// Count before
const before = await Purchase.countDocuments({ status: "pending" });
console.log(`Pending purchases before cleanup: ${before}`);

// Show breakdown by user
const byUser = await Purchase.aggregate([
  { $match: { status: "pending" } },
  { $group: { _id: "$user", count: { $sum: 1 }, plans: { $push: "$planId" } } },
  { $sort: { count: -1 } },
]);

console.log("\nBreakdown by user:");
for (const u of byUser) {
  console.log(`  User ${u._id}: ${u.count} pending (${u.plans.join(", ")})`);
}

// Delete all pending — these are all abandoned checkouts
// (transactionId:null means Flutterwave never confirmed)
const result = await Purchase.deleteMany({ status: "pending" });
console.log(`\n✓ Deleted ${result.deletedCount} pending purchase records`);

// Verify
const after = await Purchase.countDocuments({ status: "pending" });
console.log(`Pending purchases after cleanup: ${after}`);

await mongoose.disconnect();
console.log("\nDone ✓");
