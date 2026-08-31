// lib/fxRates.js
//
// FX rates and fees for SmileBaba Money.
//
// Every number a user sees on the review screen comes from here, is stored
// on the Transfer, and is re-read at charge time. The client never supplies
// a rate, a fee, or a receive amount.

import axios from "axios";

const money = (n) => Math.round(Number(n || 0) * 100) / 100;

// ─── Corridors ───────────────────────────────────────────────────────
// Add a row → the corridor goes live. Nothing else to change.
export const CORRIDORS = {
  "USD-GHS": { min: 5, max: 5_000, feeFlat: 1.99, feePercent: 0.005 },
  "USD-NGN": { min: 5, max: 5_000, feeFlat: 1.99, feePercent: 0.005 },
  "GBP-GHS": { min: 5, max: 4_000, feeFlat: 1.49, feePercent: 0.005 },
  "GBP-NGN": { min: 5, max: 4_000, feeFlat: 1.49, feePercent: 0.005 },
  "EUR-GHS": { min: 5, max: 4_500, feeFlat: 1.79, feePercent: 0.005 },
  "EUR-NGN": { min: 5, max: 4_500, feeFlat: 1.79, feePercent: 0.005 },
  "GHS-NGN": { min: 50, max: 50_000, feeFlat: 5, feePercent: 0.01 },
  "NGN-GHS": { min: 5_000, max: 5_000_000, feeFlat: 500, feePercent: 0.01 },
};

/** Our margin on the mid-market rate. 1.5% is typical for this corridor set. */
const RATE_MARGIN = Number(process.env.SMILEBABA_FX_MARGIN ?? 0.015);

/** How long a quote stays valid. Long enough to fill the form, short enough
 *  that we don't eat a rate move. */
export const QUOTE_TTL_MINUTES = 15;

// ─── Rate cache (in-process, 10 min) ─────────────────────────────────
// Upstash is available if you'd rather share this across dynos — but rates
// only move a little in 10 minutes and this avoids a network hop per quote.
const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { value, at: Date.now() });
}

// ─── Fallback rates ──────────────────────────────────────────────────
// Used only when the rate provider is unreachable. Deliberately
// conservative (slightly worse for us) so an outage can't be arbitraged.
const FALLBACK_RATES = {
  "USD-GHS": 15.0,
  "GBP-GHS": 19.0,
  "EUR-GHS": 16.3,
  "USD-NGN": 1_580.0,
  "GBP-NGN": 2_000.0,
  "EUR-NGN": 1_715.0,
  "GHS-NGN": 105.0,
  "NGN-GHS": 0.0095,
};

/**
 * Fetch the mid-market rate for a pair.
 * Provider is swappable — set FX_PROVIDER_URL to any endpoint returning
 * { rates: { GHS: 15.02, … } } for the given base.
 */
async function fetchMidRate(from, to) {
  const key = `${from}-${to}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const url = process.env.FX_PROVIDER_URL
    ? `${process.env.FX_PROVIDER_URL}?base=${from}&symbols=${to}`
    : `https://open.er-api.com/v6/latest/${from}`;

  try {
    const { data } = await axios.get(url, { timeout: 8_000 });
    const rate = Number(data?.rates?.[to]);
    if (rate > 0) {
      cacheSet(key, rate);
      return rate;
    }
    throw new Error("rate missing from provider response");
  } catch (err) {
    console.warn(`[fx] ${key} lookup failed (${err.message}) — using fallback`);
    const fallback = FALLBACK_RATES[key];
    if (!fallback) throw new Error(`No rate available for ${key}`);
    return fallback;
  }
}

/**
 * Build a full quote. This is the only place transfer money math happens.
 *
 * @returns {{
 *   sendAmount, sendCurrency, receiveAmount, receiveCurrency,
 *   rate, midRate, rateMargin, fee, totalCharge,
 *   quoteExpiresAt, corridor
 * }}
 */
export async function getQuote({ sendAmount, sendCurrency, receiveCurrency }) {
  const from = String(sendCurrency).toUpperCase();
  const to = String(receiveCurrency).toUpperCase();
  const key = `${from}-${to}`;

  const corridor = CORRIDORS[key];
  if (!corridor) {
    const err = new Error(`We don't support ${from} → ${to} yet.`);
    err.code = "CORRIDOR_UNSUPPORTED";
    throw err;
  }

  const amount = money(sendAmount);
  if (!(amount > 0)) {
    const err = new Error("Enter an amount to send.");
    err.code = "INVALID_AMOUNT";
    throw err;
  }
  if (amount < corridor.min) {
    const err = new Error(`Minimum transfer is ${corridor.min} ${from}.`);
    err.code = "BELOW_MINIMUM";
    throw err;
  }
  if (amount > corridor.max) {
    const err = new Error(
      `Maximum transfer is ${corridor.max.toLocaleString()} ${from}. ` +
        `For larger amounts, contact support.`,
    );
    err.code = "ABOVE_MAXIMUM";
    throw err;
  }

  const midRate = await fetchMidRate(from, to);

  // Our rate is slightly below mid — that spread is the margin
  const rate = money(midRate * (1 - RATE_MARGIN));

  const fee = money(corridor.feeFlat + amount * corridor.feePercent);
  const totalCharge = money(amount + fee);

  // Recipient gets the send amount at our rate. Fee is charged on top,
  // never deducted from what they receive.
  const receiveAmount = money(amount * rate);

  return {
    sendAmount: amount,
    sendCurrency: from,
    receiveAmount,
    receiveCurrency: to,
    rate,
    midRate: money(midRate),
    rateMargin: RATE_MARGIN,
    fee,
    totalCharge,
    quoteExpiresAt: new Date(Date.now() + QUOTE_TTL_MINUTES * 60_000),
    corridor: key,
  };
}

/** Reverse quote: "recipient should get exactly X" → what sender pays. */
export async function getReverseQuote({
  receiveAmount,
  sendCurrency,
  receiveCurrency,
}) {
  const from = String(sendCurrency).toUpperCase();
  const to = String(receiveCurrency).toUpperCase();

  const midRate = await fetchMidRate(from, to);
  const rate = money(midRate * (1 - RATE_MARGIN));
  const needed = money(Number(receiveAmount) / rate);

  return getQuote({
    sendAmount: needed,
    sendCurrency: from,
    receiveCurrency: to,
  });
}

/** Corridors the app should offer, for the send screen's pickers. */
export function listCorridors() {
  return Object.entries(CORRIDORS).map(([key, c]) => {
    const [from, to] = key.split("-");
    return { corridor: key, from, to, min: c.min, max: c.max };
  });
}

/** Has a stored quote gone stale? */
export function isQuoteExpired(quoteExpiresAt) {
  return !quoteExpiresAt || new Date(quoteExpiresAt) < new Date();
}

export { money };
