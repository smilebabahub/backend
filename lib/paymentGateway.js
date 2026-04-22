// lib/paymentGateway.js
// Single abstraction over all payment providers.
// Each country gets its own gateway config — controller stays identical.

import axios from "axios";
import crypto from "crypto";

// ── Gateway configs per country code ──────────────────────────────────────
// ── Single Flutterwave account for all countries ──────────────────────────
// Keys are read lazily (at call time, not import time) so dotenv has already
// loaded by the time any payment request fires.

function flwKey() {
  return (
    process.env.FLW_SECRET_KEY_GH ??
    process.env.FLW_SECRET_KEY_NG ??
    process.env.FLW_SECRET_KEY ??
    ""
  );
}

function flwWebhook() {
  return (
    process.env.FLW_WEBHOOK_SECRET_GH ??
    process.env.FLW_WEBHOOK_SECRET_NG ??
    process.env.FLW_WEBHOOK_SECRET ??
    ""
  );
}

const GATEWAYS = {
  GH: {
    currency: "GHS",
    provider: "flutterwave",
    get secretKey() {
      return process.env.FLW_SECRET_KEY_GH ?? flwKey();
    },
    get webhookSecret() {
      return process.env.FLW_WEBHOOK_SECRET_GH ?? flwWebhook();
    },
  },
  NG: {
    currency: "NGN",
    provider: "flutterwave",
    get secretKey() {
      return process.env.FLW_SECRET_KEY_NG ?? flwKey();
    },
    get webhookSecret() {
      return process.env.FLW_WEBHOOK_SECRET_NG ?? flwWebhook();
    },
  },
  INTL: {
    currency: "USD",
    provider: "flutterwave",
    get secretKey() {
      return process.env.FLW_SECRET_KEY_INTL ?? flwKey();
    },
    get webhookSecret() {
      return process.env.FLW_WEBHOOK_SECRET_INTL ?? flwWebhook();
    },
  },
};

// Derive country code from currency or country string
export function getCountryCode(currency, country = "") {
  if (currency === "GHS" || country.toLowerCase().includes("ghana"))
    return "GH";
  if (currency === "NGN" || country.toLowerCase().includes("nigeria"))
    return "NG";
  return "INTL";
}

export function getGateway(countryCode) {
  return GATEWAYS[countryCode] ?? GATEWAYS.INTL;
}

// ── Flutterwave ────────────────────────────────────────────────────────────
async function flutterwaveInitialize({ gateway, payload }) {
  if (!gateway.secretKey) {
    throw new Error(
      "Flutterwave secret key not set. Add FLW_SECRET_KEY to your .env file. " +
        `Keys checked: FLW_SECRET_KEY_${gateway.currency === "GHS" ? "GH" : "NG"}, FLW_SECRET_KEY`,
    );
  }
  const response = await axios.post(
    "https://api.flutterwave.com/v3/payments",
    payload,
    { headers: { Authorization: `Bearer ${gateway.secretKey}` } },
  );
  return { paymentLink: response.data.data.link };
}

async function flutterwaveVerify({ gateway, transactionId }) {
  const response = await axios.get(
    `https://api.flutterwave.com/v3/transactions/${transactionId}/verify`,
    { headers: { Authorization: `Bearer ${gateway.secretKey}` } },
  );

  const data = response.data.data;

  // Normalise Flutterwave response so controllers can treat it
  // identically to Paystack — both return the same shape after this.
  //
  // Flutterwave quirks to handle:
  //   - status "success" or "successful" (both mean paid)
  //   - charged_amount is the actual settled amount (amount may differ)
  //   - meta is at data.meta OR data.payment_meta depending on FLW version
  //   - amount is in the currency's base unit (NGN is naira not kobo)
  const rawMeta = data.meta ?? data.payment_meta ?? {};

  return {
    id: data.id,
    status:
      data.status === "successful" || data.status === "success"
        ? "successful"
        : data.status,
    // Use charged_amount (what was actually debited) — falls back to amount
    amount: data.charged_amount ?? data.amount,
    currency: data.currency,
    tx_ref: data.tx_ref,
    // FLW wraps custom meta under a "meta" key which can be the raw object
    // or an array of { metaname, metavalue } pairs
    meta: Array.isArray(rawMeta)
      ? rawMeta.reduce((acc, item) => {
          acc[item.metaname] = item.metavalue;
          return acc;
        }, {})
      : rawMeta,
  };
}

// ── Paystack (Nigeria — ready to enable) ──────────────────────────────────
async function paystackInitialize({ gateway, payload }) {
  const response = await axios.post(
    "https://api.paystack.co/transaction/initialize",
    {
      email: payload.customer.email,
      amount: payload.amount * 100, // Paystack uses kobo
      currency: payload.currency,
      reference: payload.tx_ref,
      callback_url: payload.redirect_url,
      metadata: {
        userId: payload.meta.userId,
        planId: payload.meta.planId,
        billingCycle: payload.meta.billingCycle,
        returnUrl: payload.meta.returnUrl,
        provider: "paystack",
      },
      customizations: {
        name: payload.customizations?.title,
        description: payload.customizations?.description,
        logo: payload.customizations?.logo,
      },
    },
    { headers: { Authorization: `Bearer ${gateway.secretKey}` } },
  );
  return { paymentLink: response.data.data.authorization_url };
}

async function paystackVerify({ gateway, reference }) {
  const response = await axios.get(
    `https://api.paystack.co/transaction/verify/${reference}`,
    { headers: { Authorization: `Bearer ${gateway.secretKey}` } },
  );

  const data = response.data.data;

  // Normalise Paystack response to match Flutterwave shape
  // so the controller can treat both identically
  return {
    id: data.id,
    status: data.status === "success" ? "successful" : data.status,
    amount: data.amount / 100, // convert kobo back to naira
    currency: data.currency,
    tx_ref: data.reference,
    meta: data.metadata ?? {},
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize a payment through the correct gateway for the given country.
 *
 * @param {object} options
 * @param {string} options.countryCode  - "GH" | "NG" | "INTL"
 * @param {object} options.payload      - Flutterwave-shaped payload (gateway adapts internally)
 * @returns {{ paymentLink: string }}
 */
export async function initializeGatewayPayment({ countryCode, payload }) {
  const gateway = getGateway(countryCode);

  switch (gateway.provider) {
    case "paystack":
      return paystackInitialize({ gateway, payload });
    case "flutterwave":
    default:
      return flutterwaveInitialize({ gateway, payload });
  }
}

/**
 * Verify a payment through the correct gateway.
 *
 * @param {object} options
 * @param {string} options.countryCode    - "GH" | "NG" | "INTL"
 * @param {string} options.transactionId  - FLW transaction_id or Paystack reference
 * @returns {object} Normalised payment object
 */
export async function verifyGatewayPayment({ countryCode, transactionId }) {
  const gateway = getGateway(countryCode);

  switch (gateway.provider) {
    case "paystack":
      return paystackVerify({ gateway, reference: transactionId });
    case "flutterwave":
    default:
      return flutterwaveVerify({ gateway, transactionId });
  }
}

/**
 * Verify a webhook signature for the given country's gateway.
 * Returns true if the signature is valid.
 */
export function verifyWebhookSignature({ countryCode, headers, body }) {
  const gateway = getGateway(countryCode);

  switch (gateway.provider) {
    case "paystack": {
      // Paystack uses HMAC-SHA512 — crypto is imported at the top of the file
      const hash = crypto
        .createHmac("sha512", gateway.webhookSecret)
        .update(JSON.stringify(body))
        .digest("hex");
      return headers["x-paystack-signature"] === hash;
    }
    case "flutterwave":
    default:
      return headers["verif-hash"] === gateway.webhookSecret;
  }
}
