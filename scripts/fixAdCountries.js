// scripts/fixAdCountries.js
// One-time backfill to fix ads with wrong location.country.
//
// The problem: user.country was wrong in DB (Ghana for Nigerian users),
// so ads were saved with location.country=Ghana even for Nigerian vendors.
// Also: some Nigerian vendors posted with GHS currency by mistake, but
// their region/city/phone clearly indicate Nigeria.
//
// Signal priority (same as inferCountry in adController.js):
//   1. NGN currency         — strong Nigeria signal
//   2. Nigerian state       — region field matches known Nigerian state
//   3. Nigerian city        — city field matches known Nigerian city
//   4. Nigerian phone       — +234, 234xxx, or 0[789]xxxxxxxx format
//   5. GHS currency         — Ghana signal (lower than region)
//   6. Ghanaian region
//
// Run from backend root:  node scripts/fixAdCountries.js

import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

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
  "Borno",
  "Enugu",
  "Katsina",
  "Adamawa",
  "Cross River",
  "Akwa Ibom",
  "Sokoto",
  "Kwara",
  "Osun",
  "Ondo",
  "Bauchi",
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

const NG_CITIES = new Set([
  "Ikeja",
  "Lekki",
  "Victoria Island",
  "Surulere",
  "Yaba",
  "Ajah",
  "Festac",
  "Ikorodu",
  "Gbagada",
  "Oshodi",
  "Agege",
  "Alimosho",
  "Badagry",
  "Epe",
  "Port Harcourt",
  "Aba",
  "Onitsha",
  "Warri",
  "Benin City",
  "Calabar",
  "Uyo",
  "Enugu City",
  "Owerri",
  "Kaduna City",
  "Ibadan",
  "Kano City",
  "Abuja",
  "Maiduguri",
  "Ilorin",
  "Abeokuta",
  "Akure",
  "Osogbo",
]);

const GH_REGIONS = new Set([
  "Greater Accra",
  "Ashanti",
  "Western",
  "Eastern",
  "Central",
  "Northern",
  "Upper East",
  "Upper West",
  "Volta",
  "Brong-Ahafo",
  "Western North",
  "Ahafo",
  "Bono East",
  "Oti",
  "North East",
  "Savannah",
]);

function isNGPhone(p = "") {
  const clean = p.replace(/\s/g, "");
  return (
    clean.startsWith("+234") ||
    clean.startsWith("234") ||
    /^0[789]\d{9}$/.test(clean)
  );
}

await mongoose.connect(process.env.MONGO_URI);
console.log("✓ Connected to MongoDB\n");

const Ad = mongoose.model("Ad", new mongoose.Schema({}, { strict: false }));
const all = await Ad.find({}).select("location price contact delivery").lean();

let ngCount = 0;
let ghCount = 0;
let skipped = 0;

for (const ad of all) {
  const currency = (ad.price?.currency || "").toUpperCase();
  const region = (ad.location?.region || "").trim();
  const city = (ad.location?.city || "").trim();
  const phone = ad.contact?.phone || "";
  const whatsapp = ad.contact?.whatsapp || "";
  const current = ad.location?.country;

  let inferredCountry = null;
  let inferredCountryCode = null;

  // Apply same priority as adController.inferCountry
  if (currency === "NGN") {
    inferredCountry = "Nigeria";
    inferredCountryCode = "NG";
  } else if (NG_STATES.has(region)) {
    inferredCountry = "Nigeria";
    inferredCountryCode = "NG";
  } else if (NG_CITIES.has(city)) {
    inferredCountry = "Nigeria";
    inferredCountryCode = "NG";
  } else if (isNGPhone(phone) || isNGPhone(whatsapp)) {
    inferredCountry = "Nigeria";
    inferredCountryCode = "NG";
  } else if (currency === "GHS") {
    inferredCountry = "Ghana";
    inferredCountryCode = "GH";
  } else if (GH_REGIONS.has(region)) {
    inferredCountry = "Ghana";
    inferredCountryCode = "GH";
  } else {
    inferredCountry = current || "Ghana";
    inferredCountryCode = inferredCountry === "Nigeria" ? "NG" : "GH";
  }

  if (inferredCountry === current) {
    skipped++;
    continue;
  }

  await Ad.updateOne(
    { _id: ad._id },
    {
      $set: {
        "location.country": inferredCountry,
        "location.countryCode": inferredCountryCode,
      },
    },
  );

  if (inferredCountry === "Nigeria") ngCount++;
  else ghCount++;

  console.log(
    `Fixed [${ad._id}]: ${current || "?"} → ${inferredCountry}` +
      ` (region: ${region}, city: ${city}, currency: ${currency}, phone: ${phone})`,
  );
}

const [gh, ng, other] = await Promise.all([
  Ad.countDocuments({ "location.country": "Ghana" }),
  Ad.countDocuments({ "location.country": "Nigeria" }),
  Ad.countDocuments({ "location.country": { $nin: ["Ghana", "Nigeria"] } }),
]);

console.log(`\n=== Results ===`);
console.log(`Fixed → Nigeria: ${ngCount}`);
console.log(`Fixed → Ghana:   ${ghCount}`);
console.log(`Already correct: ${skipped}`);
console.log(`\n=== Final DB counts ===`);
console.log(`🇬🇭  Ghana:   ${gh}`);
console.log(`🇳🇬  Nigeria: ${ng}`);
console.log(`❓  Other:   ${other}`);

await mongoose.disconnect();
console.log("\nDone ✓");
