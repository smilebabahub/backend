// scripts/fixAdVisibility.js
// One-time script to fix ads that are invisible due to:
//   1. Missing location.country (empty string or null)
//   2. isActive:false despite not being sold/paused/expired
//   3. Wrong country tag (inferred from price/region signals)
//
// Run once: node scripts/fixAdVisibility.js
// Safe to run multiple times — uses targeted $set operations.

import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

await mongoose.connect(process.env.MONGO_URI);
console.log("✓ Connected\n");

const Ad = mongoose.model("Ad", new mongoose.Schema({}, { strict: false }));
const now = new Date();

// ── 1. Fix ads with missing/empty location.country ─────────────────────────
// Use currency and region signals to infer the correct country.
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
// Criteria: not sold, not paused, not expired, moderation approved
const wronglyInactive = await Ad.find({
  isActive: false,
  isSold: false,
  isPaused: { $ne: true },
  $or: [
    { expiresAt: { $gt: now } },
    { expiresAt: null },
    { expiresAt: { $exists: false } },
  ],
  "moderation.status": { $in: ["approved", undefined, null, ""] },
}).lean();

console.log(
  `Found ${wronglyInactive.length} ads that are inactive but should be active`,
);

let fixedActive = 0;
for (const ad of wronglyInactive) {
  await Ad.findByIdAndUpdate(ad._id, {
    $set: {
      isActive: true,
      "moderation.status": "approved",
    },
  });
  fixedActive++;
  console.log(`  ✓ Restored: ${ad.title} (${ad._id})`);
}
console.log(`  Fixed: ${fixedActive}\n`);

// ── 3. Fix ads with no expiresAt — give them a default 30-day window ────────
const noExpiry = await Ad.find({
  isActive: true,
  $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }],
}).lean();

console.log(`Found ${noExpiry.length} active ads with no expiresAt`);

let fixedExpiry = 0;
for (const ad of noExpiry) {
  // Give them 30 days from now — they'll show up immediately
  const expiresAt = new Date(now.getTime() + 30 * 86400000);
  await Ad.findByIdAndUpdate(ad._id, { $set: { expiresAt } });
  fixedExpiry++;
}
console.log(`  Fixed: ${fixedExpiry}\n`);

// ── Summary ─────────────────────────────────────────────────────────────────
console.log("=== Summary ===");
console.log(`Country fixed:     ${fixedCountry}`);
console.log(`Reactivated:       ${fixedActive}`);
console.log(`Expiry date added: ${fixedExpiry}`);

await mongoose.disconnect();
console.log("\nDone ✓");
