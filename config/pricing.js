// config/pricing.js
// Single source of truth — mirrors src/constants/subscription.ts packages array
// Keys match package `id` fields exactly

export const PRICING = {
  Basic: {
    monthly: { GHS: 0, NGN: 0 },
    yearly: { GHS: 0, NGN: 0 },
  },
  standard: {
    monthly: { GHS: 99.99, NGN: 6500 },
    yearly: { GHS: 1199.88, NGN: 78000 },
  },
  popular: {
    monthly: { GHS: 249.99, NGN: 18000 },
    yearly: { GHS: 2999.88, NGN: 216000 },
  },
  premium: {
    monthly: { GHS: 499.99, NGN: 49999 },
    yearly: { GHS: 5999.88, NGN: 599999 },
  },
};


// Human-readable plan names for notifications and receipts
export const PLAN_NAMES = {
  Basic:    "Smile (Free)",
  standard: "BasicSmile",
  popular:  "HappySmile",
  premium:  "SuperSmile",
};

// ── Per-plan ad limits ────────────────────────────────────────────────────────
export const PLAN_AD_LIMITS = {
  Basic:    1,
  standard: 5,
  popular:  10,
  premium:  Infinity,
};

// ── Per-plan ad duration in days ─────────────────────────────────────────────
export const PLAN_AD_DURATION_DAYS = {
  Basic:    3,
  standard: 30,
  popular:  30,
  premium:  60,
};

export function getPlanLimit(planId) {
  return PLAN_AD_LIMITS[planId] ?? 3;
}

export function getPlanDurationDays(planId) {
  return PLAN_AD_DURATION_DAYS[planId] ?? 14;
}

// Human-readable plan names for notifications and receipts
// export const PLAN_NAMES = {
//   Basic: "Smile (Free)",
//   standard: "BasicSmile",
//   popular: "HappySmile",
//   premium: "SuperSmile",
// };
