// seeds/01_regions.seed.js
// Run: node seeds/01_regions.seed.js

import mongoose from "mongoose";

const MONGO_URI =
  process.env.MONGO_URI || "mongodb://localhost:27017/marketplace";

const regionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true },
    capital: { type: String, required: true },
    majorCities: [{ type: String }],
    country: { type: String, required: true, enum: ["Ghana", "Nigeria"] },
    countryCode: { type: String, required: true, enum: ["GH", "NG"] },
  },
  { timestamps: true },
);

// Compound unique: same region name can exist across countries (e.g. "Northern")
regionSchema.index({ name: 1, country: 1 }, { unique: true });

const Region = mongoose.models.Region || mongoose.model("Region", regionSchema);

// ── Ghana — 16 regions ────────────────────────────────────────────────────
const ghanaRegions = [
  {
    name: "Greater Accra",
    slug: "gh-greater-accra",
    capital: "Accra",
    country: "Ghana",
    countryCode: "GH",
    majorCities: ["Accra Metropolitan", "Tema", "Madina", "Weija", "Kasoa"],
  },
  {
    name: "Ashanti",
    slug: "gh-ashanti",
    capital: "Kumasi",
    country: "Ghana",
    countryCode: "GH",
    majorCities: [
      "Kumasi Metropolitan",
      "Ejisu",
      "Obuasi",
      "Asokwa",
      "Konongo",
    ],
  },
  {
    name: "Central",
    slug: "gh-central",
    capital: "Cape Coast",
    country: "Ghana",
    countryCode: "GH",
    majorCities: ["Cape Coast", "Elmina", "Swedru", "Kasoa"],
  },
  {
    name: "Eastern",
    slug: "gh-eastern",
    capital: "Koforidua",
    country: "Ghana",
    countryCode: "GH",
    majorCities: ["Koforidua", "Nkawkaw", "Akwatia", "Suhum"],
  },
  {
    name: "Volta",
    slug: "gh-volta",
    capital: "Ho",
    country: "Ghana",
    countryCode: "GH",
    majorCities: ["Ho", "Kpando", "Hohoe", "Aflao"],
  },
  {
    name: "Western",
    slug: "gh-western",
    capital: "Sekondi-Takoradi",
    country: "Ghana",
    countryCode: "GH",
    majorCities: [
      "Sekondi-Takoradi",
      "Takoradi",
      "Takoradi Port",
      "Takoradi Harbour",
    ],
  },
  {
    name: "Western North",
    slug: "gh-western-north",
    capital: "Sefwi Wiawso",
    country: "Ghana",
    countryCode: "GH",
    majorCities: ["Sefwi Wiawso", "Bibiani", "Essaman"],
  },
  {
    name: "Bono",
    slug: "gh-bono",
    capital: "Sunyani",
    country: "Ghana",
    countryCode: "GH",
    majorCities: ["Sunyani", "Techiman", "Dormaa Ahenkro"],
  },
  {
    name: "Bono East",
    slug: "gh-bono-east",
    capital: "Techiman",
    country: "Ghana",
    countryCode: "GH",
    majorCities: ["Techiman", "Yeji"],
  },
  {
    name: "Ahafo",
    slug: "gh-ahafo",
    capital: "Goaso",
    country: "Ghana",
    countryCode: "GH",
    majorCities: ["Goaso", "Kukuom"],
  },
  {
    name: "Oti",
    slug: "gh-oti",
    capital: "Dambai",
    country: "Ghana",
    countryCode: "GH",
    majorCities: ["Dambai", "Nkwanta"],
  },
  {
    name: "Savannah",
    slug: "gh-savannah",
    capital: "Damongo",
    country: "Ghana",
    countryCode: "GH",
    majorCities: ["Damongo", "Bole"],
  },
  {
    name: "North East",
    slug: "gh-north-east",
    capital: "Nalerigu",
    country: "Ghana",
    countryCode: "GH",
    majorCities: ["Nalerigu", "Gambaga"],
  },
  {
    name: "Northern",
    slug: "gh-northern",
    capital: "Tamale",
    country: "Ghana",
    countryCode: "GH",
    majorCities: ["Tamale", "Yendi", "Savelugu"],
  },
  {
    name: "Upper East",
    slug: "gh-upper-east",
    capital: "Bolgatanga",
    country: "Ghana",
    countryCode: "GH",
    majorCities: ["Bolgatanga", "Navrongo", "Paga"],
  },
  {
    name: "Upper West",
    slug: "gh-upper-west",
    capital: "Wa",
    country: "Ghana",
    countryCode: "GH",
    majorCities: ["Wa", "Jirapa", "Lambussie"],
  },
];

// ── Nigeria — 36 states + FCT ─────────────────────────────────────────────
const nigeriaRegions = [
  {
    name: "Abia",
    slug: "ng-abia",
    capital: "Umuahia",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Umuahia", "Aba", "Ohafia", "Arochukwu"],
  },
  {
    name: "Adamawa",
    slug: "ng-adamawa",
    capital: "Yola",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Yola", "Mubi", "Numan", "Jimeta"],
  },
  {
    name: "Akwa Ibom",
    slug: "ng-akwa-ibom",
    capital: "Uyo",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Uyo", "Eket", "Ikot Ekpene", "Oron"],
  },
  {
    name: "Anambra",
    slug: "ng-anambra",
    capital: "Awka",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Awka", "Onitsha", "Nnewi", "Ekwulobia"],
  },
  {
    name: "Bauchi",
    slug: "ng-bauchi",
    capital: "Bauchi",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Bauchi", "Azare", "Misau", "Katagum"],
  },
  {
    name: "Bayelsa",
    slug: "ng-bayelsa",
    capital: "Yenagoa",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Yenagoa", "Ogbia", "Brass", "Sagbama"],
  },
  {
    name: "Benue",
    slug: "ng-benue",
    capital: "Makurdi",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Makurdi", "Gboko", "Otukpo", "Katsina-Ala"],
  },
  {
    name: "Borno",
    slug: "ng-borno",
    capital: "Maiduguri",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Maiduguri", "Biu", "Kukawa", "Monguno"],
  },
  {
    name: "Cross River",
    slug: "ng-cross-river",
    capital: "Calabar",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Calabar", "Ikom", "Ogoja", "Obudu"],
  },
  {
    name: "Delta",
    slug: "ng-delta",
    capital: "Asaba",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Asaba", "Warri", "Ughelli", "Sapele"],
  },
  {
    name: "Ebonyi",
    slug: "ng-ebonyi",
    capital: "Abakaliki",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Abakaliki", "Afikpo", "Onueke", "Ezza"],
  },
  {
    name: "Edo",
    slug: "ng-edo",
    capital: "Benin City",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Benin City", "Auchi", "Ekpoma", "Uromi"],
  },
  {
    name: "Ekiti",
    slug: "ng-ekiti",
    capital: "Ado Ekiti",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Ado Ekiti", "Ikere", "Oye", "Ijero"],
  },
  {
    name: "Enugu",
    slug: "ng-enugu",
    capital: "Enugu",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Enugu", "Nsukka", "Agbani", "Oji River"],
  },
  {
    name: "FCT — Abuja",
    slug: "ng-fct-abuja",
    capital: "Abuja",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Abuja", "Gwagwalada", "Kuje", "Bwari", "Kubwa"],
  },
  {
    name: "Gombe",
    slug: "ng-gombe",
    capital: "Gombe",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Gombe", "Kaltungo", "Billiri", "Dukku"],
  },
  {
    name: "Imo",
    slug: "ng-imo",
    capital: "Owerri",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Owerri", "Orlu", "Okigwe", "Oguta"],
  },
  {
    name: "Jigawa",
    slug: "ng-jigawa",
    capital: "Dutse",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Dutse", "Hadejia", "Gumel", "Kazaure"],
  },
  {
    name: "Kaduna",
    slug: "ng-kaduna",
    capital: "Kaduna",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Kaduna", "Zaria", "Kafanchan", "Zonkwa"],
  },
  {
    name: "Kano",
    slug: "ng-kano",
    capital: "Kano",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Kano", "Wudil", "Gwarzo", "Rano"],
  },
  {
    name: "Katsina",
    slug: "ng-katsina",
    capital: "Katsina",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Katsina", "Daura", "Funtua", "Malumfashi"],
  },
  {
    name: "Kebbi",
    slug: "ng-kebbi",
    capital: "Birnin Kebbi",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Birnin Kebbi", "Argungu", "Yauri", "Zuru"],
  },
  {
    name: "Kogi",
    slug: "ng-kogi",
    capital: "Lokoja",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Lokoja", "Okene", "Kabba", "Ankpa"],
  },
  {
    name: "Kwara",
    slug: "ng-kwara",
    capital: "Ilorin",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Ilorin", "Offa", "Jebba", "Lafiagi"],
  },
  {
    name: "Lagos",
    slug: "ng-lagos",
    capital: "Ikeja",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: [
      "Lagos Island",
      "Ikeja",
      "Lekki",
      "Victoria Island",
      "Surulere",
      "Ikorodu",
      "Badagry",
    ],
  },
  {
    name: "Nasarawa",
    slug: "ng-nasarawa",
    capital: "Lafia",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Lafia", "Keffi", "Akwanga", "Nasarawa"],
  },
  {
    name: "Niger",
    slug: "ng-niger",
    capital: "Minna",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Minna", "Bida", "Kontagora", "Suleja"],
  },
  {
    name: "Ogun",
    slug: "ng-ogun",
    capital: "Abeokuta",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Abeokuta", "Sagamu", "Ijebu-Ode", "Ota"],
  },
  {
    name: "Ondo",
    slug: "ng-ondo",
    capital: "Akure",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Akure", "Ondo", "Owo", "Ikare"],
  },
  {
    name: "Osun",
    slug: "ng-osun",
    capital: "Osogbo",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Osogbo", "Ile-Ife", "Ilesa", "Ede"],
  },
  {
    name: "Oyo",
    slug: "ng-oyo",
    capital: "Ibadan",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Ibadan", "Ogbomosho", "Oyo", "Iseyin"],
  },
  {
    name: "Plateau",
    slug: "ng-plateau",
    capital: "Jos",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Jos", "Bukuru", "Shendam", "Pankshin"],
  },
  {
    name: "Rivers",
    slug: "ng-rivers",
    capital: "Port Harcourt",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Port Harcourt", "Bonny", "Okrika", "Omoku"],
  },
  {
    name: "Sokoto",
    slug: "ng-sokoto",
    capital: "Sokoto",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Sokoto", "Tambuwal", "Wurno", "Gwadabawa"],
  },
  {
    name: "Taraba",
    slug: "ng-taraba",
    capital: "Jalingo",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Jalingo", "Wukari", "Gembu", "Bali"],
  },
  {
    name: "Yobe",
    slug: "ng-yobe",
    capital: "Damaturu",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Damaturu", "Potiskum", "Gashua", "Nguru"],
  },
  {
    name: "Zamfara",
    slug: "ng-zamfara",
    capital: "Gusau",
    country: "Nigeria",
    countryCode: "NG",
    majorCities: ["Gusau", "Kaura Namoda", "Talata Mafara", "Anka"],
  },
];

const regions = [...ghanaRegions, ...nigeriaRegions];

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log("🔌 Connected to MongoDB");

  await Region.deleteMany({});
  console.log("🧹 Cleared regions collection");

  const inserted = await Region.insertMany(regions);
  const ghCount = inserted.filter((r) => r.countryCode === "GH").length;
  const ngCount = inserted.filter((r) => r.countryCode === "NG").length;
  console.log(
    `✅ Seeded ${inserted.length} regions — Ghana: ${ghCount}, Nigeria: ${ngCount}`,
  );

  await mongoose.disconnect();
  console.log("🔒 Disconnected");
}

seed().catch((err) => {
  console.error("❌ Seed failed:", err);
  process.exit(1);
});
