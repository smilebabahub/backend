// scripts/fixAdVisibility.js
// One-time script to fix ads that are invisible due to:
//   1. Missing location.country (empty string or null)
//   2. isActive:false despite not being sold/paused/expired
//   3. No expiresAt set
//   4. moderation.status:"pending" but isActive:true (trust isActive)
//
// Safe to run multiple times.
// Run: node scripts/fixAdVisibility.js

import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

await mongoose.connect(process.env.MONGO_URI);
console.log("✓ Connected\n");

const Ad = mongoose.model("Ad", new mongoose.Schema({}, { strict: false }));
const now = new Date();

const NG_STATES = new Set([
  "Lagos",
  "Abuja FCT",
  "Kano",
  "Oyo",
  "Rivers",
  "Kaduna",
  "Delta",
  "Ogun",
  "Anambra",
  "Imo",
  "Plateau",
  "Edo",
  "Enugu",
  "Katsina",
  "Cross River",
  "Akwa Ibom",
  "Sokoto",
  "Kwara",
  "Osun",
  "Ondo",
  "Niger",
  "Gombe",
  "Kebbi",
  "Zamfara",
  "Yobe",
  "Taraba",
  "Ebonyi",
  "Ekiti",
  "Nassarawa",
  "Bayelsa",
  "Jigawa",
  "Benue",
  "Abia",
  "Kogi",
]);

// ── 1. Fix ads with missing/empty location.country ─────────────────────────
const missingCountry = await Ad.find({
  $or: [
    { "location.country": { $exists: false } },
    { "location.country": "" },
    { "location.country": null },
  ],
}).lean();

console.log(`Found ${missingCountry.length} ads with missing location.country`);
let fixedCountry = 0;
for (const ad of missingCountry) {
  const currency = ad.price?.currency ?? "";
  const region = ad.location?.region ?? "";
  const country =
    currency === "NGN" || NG_STATES.has(region) ? "Nigeria" : "Ghana";
  const countryCode = country === "Nigeria" ? "NG" : "GH";
  await Ad.findByIdAndUpdate(ad._id, {
    $set: { "location.country": country, "location.countryCode": countryCode },
  });
  fixedCountry++;
}
console.log(`  Fixed: ${fixedCountry}\n`);

// ── 2. Fix ads that are inactive but should be active ──────────────────────
const wronglyInactive = await Ad.find({
  isActive: false,
  isSold: false,
  isPaused: { $ne: true },
  $or: [
    { expiresAt: { $gt: now } },
    { expiresAt: null },
    { expiresAt: { $exists: false } },
  ],
  $and: [
    {
      $or: [
        { "moderation.status": "approved" },
        { "moderation.status": { $exists: false } },
        { "moderation.status": null },
        { "moderation.status": "" },
        { "moderation.status": "pending" },
      ],
    },
  ],
}).lean();

console.log(
  `Found ${wronglyInactive.length} ads that are inactive but should be active`,
);
let fixedActive = 0;
for (const ad of wronglyInactive) {
  await Ad.findByIdAndUpdate(ad._id, {
    $set: { isActive: true, "moderation.status": "approved" },
  });
  fixedActive++;
  console.log(`  ✓ Restored: ${ad.title} (${ad._id})`);
}
console.log(`  Fixed: ${fixedActive}\n`);

// ── 3. Fix active ads with no expiresAt ────────────────────────────────────
const noExpiry = await Ad.find({
  isActive: true,
  $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }],
}).lean();

console.log(`Found ${noExpiry.length} active ads with no expiresAt`);
let fixedExpiry = 0;
for (const ad of noExpiry) {
  const expiresAt = new Date(now.getTime() + 30 * 86400000);
  await Ad.findByIdAndUpdate(ad._id, { $set: { expiresAt } });
  fixedExpiry++;
}
console.log(`  Fixed: ${fixedExpiry}\n`);

// ── 4. Approve pending-but-active ads ──────────────────────────────────────
const pendingActive = await Ad.find({
  isActive: true,
  isSold: false,
  "moderation.status": "pending",
}).lean();

console.log(`Found ${pendingActive.length} pending-but-active ads to approve`);
let fixedPending = 0;
for (const ad of pendingActive) {
  await Ad.findByIdAndUpdate(ad._id, {
    $set: { "moderation.status": "approved" },
  });
  fixedPending++;
  console.log(`  ✓ Approved: ${ad.title} (${ad._id})`);
}
console.log(`  Fixed: ${fixedPending}\n`);

// ── Summary ─────────────────────────────────────────────────────────────────
console.log("=== Summary ===");
console.log(`Country fixed:       ${fixedCountry}`);
console.log(`Reactivated:         ${fixedActive}`);
console.log(`Expiry date added:   ${fixedExpiry}`);
console.log(`Pending → approved:  ${fixedPending}`);

await mongoose.disconnect();
console.log("\nDone ✓");
