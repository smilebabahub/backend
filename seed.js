// seeds/index.js  —  master seed runner
// Usage:
//   node seeds/index.js             (runs all seeds in order)
//   node seeds/index.js regions     (runs only 01_regions)
//   node seeds/index.js categories  (runs only 02_categories)
//   node seeds/index.js fields      (runs only 03_category_fields)
//   node seeds/index.js listings    (runs only 04_listings)

import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALL_SEEDS = [
  { name: "regions", file: "01_regions.seed.js" },
  { name: "categories", file: "02_categories.seed.js" },
  { name: "fields", file: "03_category_fields.seed.js" },
  { name: "listings", file: "04_listings.seed.js" },
];

const target = process.argv[2]; // optional filter arg
const toRun = target ? ALL_SEEDS.filter((s) => s.name === target) : ALL_SEEDS;

if (toRun.length === 0) {
  console.error(
    `❌ Unknown seed target: "${target}". Options: ${ALL_SEEDS.map((s) => s.name).join(", ")}`,
  );
  process.exit(1);
}

console.log(`\n🌱 Running ${toRun.length} seed(s)...\n`);

for (const seed of toRun) {
  const filePath = path.join(__dirname, seed.file);
  console.log(`\n── ${seed.name} (${seed.file}) ──────────────────────────`);
  try {
    execSync(`node ${filePath}`, { stdio: "inherit", env: process.env });
  } catch (err) {
    console.error(`\n❌ Seed "${seed.name}" failed. Stopping.`);
    process.exit(1);
  }
}

console.log("\n✅ All seeds completed successfully.\n");
