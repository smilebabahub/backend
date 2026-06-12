// config/promoPricing.js
// Promotional campaign pricing — separate from subscription + boost pricing.
// Promo = paid video featured across TV, Radio, and social channels.

export const PROMO_TIERS = {
  starter: {
    label: "Starter",
    days: 7,
    badge: null,
    prices: { GHS: 749, NGN: 94898 },
    perks: [
      "1 week TV rotation",
      "Radio voiceover ad",
      "10 second video production",
      "Facebook + Instagram posts",
      "Basic analytics report",
    ],
  },
  growth: {
    label: "Growth",
    days: 14,
    badge: "Most Popular",
    prices: { GHS: 2499, NGN: 316621 },
    perks: [
      "2 weeks TV rotation",
      "Radio + voiceover ad",
      "30 second video production",
      "All social platforms",
      "Featured on homepage",
      "Boosted ad listing",
      "Detailed analytics",
    ],
  },
  enterprise: {
    label: "Enterprise",
    days: 30,
    badge: "Best Value",
    prices: { GHS: 3999, NGN: 506670 },
    perks: [
      "1 month TV rotation",
      "Daily radio plays",
      "All social + paid ads",
      "1 minute video production",
      "Homepage banner takeover",
      "Verified vendor badge",
      "Dedicated campaign manager",
      "Custom analytics dashboard",
    ],
  },
};

export const PROMO_TIER_NAMES = {
  starter: "Starter Promo",
  growth: "Growth Promo",
  enterprise: "Enterprise Promo",
};

export function getPromoPrice(tier, currency) {
  return PROMO_TIERS[tier]?.prices?.[currency] ?? null;
}

export function getPromoDays(tier) {
  return PROMO_TIERS[tier]?.days ?? 7;
}
