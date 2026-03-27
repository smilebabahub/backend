// config/boostPricing.js
// Pricing for ad boost tiers — separate from subscription pricing.
// Boost = pay per individual ad to increase its visibility.

export const BOOST_PRICING = {
  standard: {
    days: 7,
    label: "Standard Boost",
    desc: "Appear higher in search results",
    prices: {
      monthly: { GHS: 9.99, NGN: 5000 }, // not used — boost is one-time
      once: { GHS: 9.99, NGN: 5000 },
    },
  },
  featured: {
    days: 14,
    label: "Featured",
    desc: "Promoted badge + priority placement",
    prices: {
      once: { GHS: 19.99, NGN: 12000 },
    },
  },
  premium: {
    days: 30,
    label: "Premium Featured",
    desc: "Top of all results + homepage feature",
    prices: {
      once: { GHS: 39.99, NGN: 25000 },
    },
  },
};

export const BOOST_TIER_NAMES = {
  standard: "Standard Boost",
  featured: "Featured",
  premium: "Premium Featured",
};

// How long each boost lasts (in days)
export const BOOST_DURATION_DAYS = {
  standard: 7,
  featured: 14,
  premium: 30,
};
