// config/promoPricing.js
// Promotional campaign pricing — separate from subscription + boost pricing.
// Promo = paid video featured across TV, Radio, and social channels.

export const PROMO_TIERS = {
  starter: {
    label: "Starter",
    days: 7,
    badge: null,
    prices: { GHS: 749, NGN: 94898 },
    channels: ["tv", "radio", "social"],
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
    channels: ["tv", "radio", "social", "web"],
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
    channels: ["tv", "radio", "social", "web"],
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

// ─── Legacy helpers (keep for backwards compat) ────────────────────────
export function getPromoPrice(tier, currency) {
  return PROMO_TIERS[tier]?.prices?.[currency] ?? null;
}

export function getPromoDays(tier) {
  return PROMO_TIERS[tier]?.days ?? 7;
}

// ─── Public catalogue for a given currency ─────────────────────────────
// Returns the tiers as an ARRAY (shape the frontend expects):
//   [{ id, label, price, days, perks, currency, currencySymbol, channels, badge? }, ...]
export function tiersFor(currency = "GHS") {
  const cur = String(currency).toUpperCase() === "NGN" ? "NGN" : "GHS";
  const sym = cur === "NGN" ? "₦" : "GHC";

  return Object.entries(PROMO_TIERS).map(([id, t]) => ({
    id,
    label: t.label,
    days: t.days,
    price: t.prices[cur],
    currency: cur,
    currencySymbol: sym,
    channels: t.channels ?? [],
    perks: t.perks ?? [],
    ...(t.badge ? { badge: t.badge } : {}),
  }));
}

// ─── Look up a single tier + resolve price for country ─────────────────
// Returns { id, label, days, amount, currency, channels, perks, badge? }
// or null if the tier id doesn't exist.
export function tierFor(id, country = "Ghana") {
  const t = PROMO_TIERS[id];
  if (!t) return null;

  const isNG = country === "Nigeria";
  const currency = isNG ? "NGN" : "GHS";

  return {
    id,
    label: t.label,
    days: t.days,
    amount: t.prices[currency],
    currency,
    channels: t.channels ?? [],
    perks: t.perks ?? [],
    ...(t.badge ? { badge: t.badge } : {}),
  };
}
