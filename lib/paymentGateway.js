// lib/paymentGateway.js
// Single abstraction over all payment providers.
// Each country gets its own gateway config — controller stays identical.

import axios from "axios";
import crypto from "crypto";

// ── Gateway configs per country code ──────────────────────────────────────
const GATEWAYS = {
  GH: {
    currency: "GHS",
    provider: "flutterwave",
    secretKey: process.env.FLW_SECRET_KEY_GH ?? process.env.FLW_SECRET_KEY,
    webhookSecret:
      process.env.FLW_WEBHOOK_SECRET_GH ?? process.env.FLW_WEBHOOK_SECRET,
  },
  NG: {
    currency: "NGN",
    provider: "flutterwave", // swap to "paystack" when ready
    secretKey: process.env.FLW_SECRET_KEY_NG ?? process.env.FLW_SECRET_KEY,
    webhookSecret:
      process.env.FLW_WEBHOOK_SECRET_NG ?? process.env.FLW_WEBHOOK_SECRET,
  },
  INTL: {
    currency: "USD",
    provider: "flutterwave",
    secretKey: process.env.FLW_SECRET_KEY_INTL ?? process.env.FLW_SECRET_KEY,
    webhookSecret:
      process.env.FLW_WEBHOOK_SECRET_INTL ?? process.env.FLW_WEBHOOK_SECRET,
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
  return response.data.data;
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
