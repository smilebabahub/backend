// config/pricing.js
// Single source of truth — mirrors src/constants/subscription.ts packages array
// Keys match package `id` fields exactly

export const PRICING = {
  Basic: {
    monthly: { GHS: 0, NGN: 0 },
    yearly: { GHS: 0, NGN: 0 },
  },
  standard: {
    monthly: { GHS: 99.99, NGN: 650000 },
    yearly: { GHS: 1199.88, NGN: 7800000 },
  },
  popular: {
    monthly: { GHS: 249.99, NGN: 1800000 },
    yearly: { GHS: 2999.88, NGN: 21600000 },
  },
  premium: {
    monthly: { GHS: 499.99, NGN: 4999999 },
    yearly: { GHS: 5999.88, NGN: 59999988 },
  },
};

// Human-readable plan names for notifications and receipts
export const PLAN_NAMES = {
  Basic: "Smile (Free)",
  standard: "BasicSmile",
  popular: "HappySmile",
  premium: "SuperSmile",
};
