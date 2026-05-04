// scripts/backfillPlanPriority.js
// One-time script to set subscription.planPriority on all existing ads
// based on their subscription.plan field.
// Run: node scripts/backfillPlanPriority.js

import mongoose from "mongoose";
import Ad from "../models/adModel.js";
import dotenv from "dotenv";
dotenv.config();

const PLAN_PRIORITY = { premium: 3, popular: 2, standard: 1, Basic: 0 };

async function run() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("Connected to MongoDB");

  let updated = 0;
  const cursor = Ad.find({}).cursor();

  for await (const ad of cursor) {
    const plan = ad.subscription?.plan ?? "Basic";
    const priority = PLAN_PRIORITY[plan] ?? 0;

    if (ad.subscription?.planPriority !== priority) {
      await Ad.updateOne(
        { _id: ad._id },
        { $set: { "subscription.planPriority": priority } },
      );
      updated++;
    }
  }

  console.log(`Backfill complete: ${updated} ads updated`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
