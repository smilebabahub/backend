// config/pricing.js
// Single source of truth — mirrors src/constants/subscription.ts packages array
// Keys match package `id` fields exactly

export const PRICING = {
  Basic: {
    monthly: { GHS: 0, NGN: 0 },
    yearly: { GHS: 0, NGN: 0 },
  },
  standard: {
    monthly: { GHS: 149.99, NGN: 17776 },
    yearly: { GHS: 1799.88, NGN: 213310 },
  },
  popular: {
    monthly: { GHS: 349.99, NGN: 41479 },
    yearly: { GHS: 4199.88, NGN: 497742 },
  },
  premium: {
    monthly: { GHS: 649.99, NGN: 77033 },
    yearly: { GHS: 7799.88, NGN: 924391 },
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
