// scripts/fixMissingPurchases.js
// Backfills Purchase records for vendors whose subscription is active
// but have no corresponding Purchase document (caused by the amount mismatch
// bug in verifyPayment that silently failed before activating correctly).
//
// Run: node scripts/fixMissingPurchases.js
//
// Safe to run multiple times — uses findOneAndUpdate with upsert on a
// synthetic txRef so it never creates duplicates.

import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

await mongoose.connect(process.env.MONGO_URI);
console.log("✓ Connected to MongoDB\n");

// Use dynamic models to avoid import issues
const User = mongoose.model("User", new mongoose.Schema({}, { strict: false }));
const Purchase = mongoose.model(
  "Purchase",
  new mongoose.Schema({}, { strict: false }),
);

const vendors = await User.find({ role: "vendor" })
  .select("_id username email subscription")
  .lean();

console.log(`Found ${vendors.length} vendors\n`);

let created = 0;
let skipped = 0;

for (const vendor of vendors) {
  const sub = vendor.subscription;
  if (!sub?.plan || sub.plan === "Basic") {
    skipped++;
    continue;
  }

  // Check if a Purchase record already exists for this vendor's current plan
  const existing = await Purchase.findOne({
    user: vendor._id,
    status: "successful",
    type: "subscription",
  }).lean();

  if (existing) {
    skipped++;
    continue;
  }

  // No purchase record — create a synthetic one
  const syntheticTxRef = `backfill-${vendor._id}-${Date.now()}`;

  await Purchase.findOneAndUpdate(
    { user: vendor._id, type: "subscription", status: "successful" },
    {
      $setOnInsert: {
        user: vendor._id,
        txRef: syntheticTxRef,
        type: "subscription",
        status: "successful",
        title: `${sub.plan} Plan (backfilled)`,
        planId: sub.plan,
        billingCycle: sub.billingCycle ?? "monthly",
        amount: sub.price ?? 0,
        currency: sub.currency ?? "GHS",
        periodStart: sub.startedAt ?? new Date(),
        periodEnd: sub.expiresAt ?? new Date(),
        createdAt: sub.startedAt ?? new Date(),
      },
    },
    { upsert: true },
  );

  console.log(
    `  ✓ Created purchase for ${vendor.username} (${vendor.email}) — plan: ${sub.plan}`,
  );
  created++;
}

console.log(`\n=== Results ===`);
console.log(`Created: ${created} purchase records`);
console.log(`Skipped: ${skipped} (already have records or free plan)`);

await mongoose.disconnect();
console.log("\nDone ✓");
