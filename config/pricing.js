// config/pricing.js
// Single source of truth — mirrors src/constants/subscription.ts packages array
// Keys match package `id` fields exactly

export const PRICING = {
  Basic: {
    monthly: { GHS: 0, NGN: 0 },
    yearly: { GHS: 0, NGN: 0 },
  },
  standard: {
    monthly: { GHS: 49.99, NGN: 29999 },
    yearly: { GHS: 599.88, NGN: 359880 },
  },
  popular: {
    monthly: { GHS: 74.99, NGN: 44999 },
    yearly: { GHS: 899.99, NGN: 539994 },
  },
  premium: {
    monthly: { GHS: 99.99, NGN: 59999 },
    yearly: { GHS: 1199.0, NGN: 719400 },
  },
};

// Human-readable plan names for notifications and receipts
export const PLAN_NAMES = {
  Basic: "Smile (Free)",
  standard: "BasicSmile",
  popular: "HappySmile",
  premium: "SuperSmile",
};
