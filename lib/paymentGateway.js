// lib/paymentGateway.js
// Single abstraction over all payment providers.
// Each country gets its own gateway config — controllers stay identical.
//
// Public API:
//   getCountryCode              — derive "GH" | "NG" | "INTL" from currency/country
//   getGateway                  — resolve gateway config for a country
//   initializeGatewayPayment    — create a hosted payment link
//   verifyGatewayPayment        — verify a payment after redirect
//   verifyWebhookSignature      — check webhook came from the real gateway
//   createTransfer              — send money out (vendor payouts)
//   createRefund                — return money to buyer's original method
//   getTransferStatus           — poll a transfer's current state
//   ghBankNameToCode            — resolve GH bank name → FLW bank code

import axios from "axios";
import crypto from "crypto";

const FLW_API = "https://api.flutterwave.com/v3";

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

// ══════════════════════════════════════════════════════════════════════════
// BANK CODE TABLES
// ══════════════════════════════════════════════════════════════════════════
// Ghana bank codes used by Flutterwave for bank transfers.
// Nigerian banks are resolved by FLW's own lookup — pass the bank name and
// FLW figures out the code.
export const GH_BANK_CODES = {
  "GCB Bank": "GH010100",
  Ecobank: "GH020100",
  "Fidelity Bank": "GH240100",
  "Absa Bank": "GH030100",
  "Stanbic Bank": "GH190100",
  "Standard Chartered": "GH020200",
  "Zenith Bank": "GH120100",
  "Access Bank": "GH280100",
  CalBank: "GH140100",
  ADB: "GH080100",
};

export function ghBankNameToCode(name) {
  return GH_BANK_CODES[name] ?? null;
}

// ══════════════════════════════════════════════════════════════════════════
// FLUTTERWAVE — Payment initialization + verification
// ══════════════════════════════════════════════════════════════════════════
async function flutterwaveInitialize({ gateway, payload }) {
  if (!gateway.secretKey) {
    throw new Error(
      "Flutterwave secret key not set. Add FLW_SECRET_KEY to your .env file. " +
        `Keys checked: FLW_SECRET_KEY_${gateway.currency === "GHS" ? "GH" : "NG"}, FLW_SECRET_KEY`,
    );
  }
  const response = await axios.post(`${FLW_API}/payments`, payload, {
    headers: { Authorization: `Bearer ${gateway.secretKey}` },
  });
  return { paymentLink: response.data.data.link };
}

async function flutterwaveVerify({ gateway, transactionId }) {
  const response = await axios.get(
    `${FLW_API}/transactions/${transactionId}/verify`,
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

// ══════════════════════════════════════════════════════════════════════════
// FLUTTERWAVE — Transfers (vendor payouts)
// ══════════════════════════════════════════════════════════════════════════
// Docs: https://developer.flutterwave.com/reference/create-a-transfer
async function flutterwaveTransfer({
  gateway,
  amount,
  currency,
  narration,
  reference,
  beneficiary,
}) {
  if (!gateway.secretKey) {
    throw new Error("Flutterwave secret key not set — cannot transfer");
  }
  const payload = buildFlwTransferPayload({
    amount,
    currency,
    narration,
    reference,
    beneficiary,
  });

  try {
    const { data } = await axios.post(`${FLW_API}/transfers`, payload, {
      headers: {
        Authorization: `Bearer ${gateway.secretKey}`,
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    });

    if (data?.status !== "success") {
      throw new Error(data?.message ?? "Transfer failed");
    }

    return {
      success: true,
      transferId: data.data?.id,
      reference: data.data?.reference,
      status: data.data?.status, // NEW / PENDING / SUCCESSFUL / FAILED
      complete: data.data?.complete_message,
    };
  } catch (err) {
    const detail = err.response?.data?.message ?? err.message;
    console.error("[flutterwaveTransfer]", detail);
    throw new Error(detail);
  }
}

async function flutterwaveTransferStatus({ gateway, transferId }) {
  try {
    const { data } = await axios.get(`${FLW_API}/transfers/${transferId}`, {
      headers: { Authorization: `Bearer ${gateway.secretKey}` },
      timeout: 15_000,
    });
    return data.data;
  } catch (err) {
    console.error("[flutterwaveTransferStatus]", err.message);
    throw err;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// FLUTTERWAVE — Refunds
// ══════════════════════════════════════════════════════════════════════════
// Docs: https://developer.flutterwave.com/reference/create-refund
async function flutterwaveRefund({ gateway, flwTxId, amount, reason }) {
  if (!gateway.secretKey) {
    throw new Error("Flutterwave secret key not set — cannot refund");
  }
  if (!flwTxId) {
    throw new Error("flwTxId (Flutterwave transaction id) is required");
  }

  const payload = { comments: reason ?? "Refund" };
  if (amount != null) payload.amount = Number(amount);

  try {
    const { data } = await axios.post(
      `${FLW_API}/transactions/${flwTxId}/refund`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${gateway.secretKey}`,
          "Content-Type": "application/json",
        },
        timeout: 30_000,
      },
    );

    if (data?.status !== "success") {
      throw new Error(data?.message ?? "Refund failed");
    }

    return {
      success: true,
      refundId: data.data?.id,
      status: data.data?.status,
      amount: data.data?.amount_refunded,
    };
  } catch (err) {
    const detail = err.response?.data?.message ?? err.message;
    console.error("[flutterwaveRefund]", detail);
    throw new Error(detail);
  }
}

// ── FLW transfer payload builders (internal) ──────────────────────────────
function buildFlwTransferPayload({
  amount,
  currency,
  narration,
  reference,
  beneficiary,
}) {
  if (!beneficiary?.type) {
    throw new Error("beneficiary.type is required (momo | bank)");
  }
  if (!reference) {
    throw new Error("reference is required (use your payoutRef)");
  }

  const common = {
    amount: Number(amount),
    currency,
    narration: narration ?? "SmileBaba vendor payout",
    reference,
    debit_currency: currency, // debit from same-currency FLW wallet
  };

  if (beneficiary.type === "momo") {
    if (!beneficiary.phone || !beneficiary.network) {
      throw new Error(
        "beneficiary.phone and beneficiary.network required for MoMo",
      );
    }
    const parts = String(beneficiary.name ?? "SmileBaba Vendor").split(" ");
    return {
      ...common,
      account_bank: momoNetworkToBankCode(beneficiary.network, currency),
      account_number: cleanPhone(beneficiary.phone),
      beneficiary_name: beneficiary.name ?? "SmileBaba Vendor",
      meta: [
        {
          first_name: parts[0] ?? "Vendor",
          last_name: parts.slice(1).join(" ") || "",
          mobile_number: cleanPhone(beneficiary.phone),
          email: beneficiary.email ?? "",
        },
      ],
    };
  }

  if (beneficiary.type === "bank") {
    if (!beneficiary.bankCode || !beneficiary.accountNumber) {
      throw new Error(
        "beneficiary.bankCode and beneficiary.accountNumber required for bank",
      );
    }
    return {
      ...common,
      account_bank: beneficiary.bankCode,
      account_number: beneficiary.accountNumber,
      beneficiary_name: beneficiary.name ?? "SmileBaba Vendor",
    };
  }

  throw new Error(`Unknown beneficiary type: ${beneficiary.type}`);
}

// FLW uses "bank codes" for MoMo transfers too — one code per network
function momoNetworkToBankCode(network, currency) {
  const key = String(network)
    .toUpperCase()
    .replace(/[^A-Z]/g, "");

  if (currency === "GHS") {
    if (key.includes("MTN")) return "MTN";
    if (key.includes("VODA") || key.includes("TELECEL")) return "VOD";
    if (key.includes("AIRTEL") || key.includes("TIGO")) return "ATL";
  }
  if (currency === "NGN") {
    if (key.includes("OPAY")) return "OPAY";
    if (key.includes("PALMPAY")) return "PALMPAY";
    if (key.includes("KUDA")) return "KUDA";
    if (key.includes("MONIEPOINT")) return "MONIEPOINT";
  }
  throw new Error(`Unknown MoMo network for ${currency}: ${network}`);
}

function cleanPhone(phone) {
  return String(phone).replace(/\D/g, "");
}

// ══════════════════════════════════════════════════════════════════════════
// PAYSTACK (Nigeria — ready to enable)
// ══════════════════════════════════════════════════════════════════════════
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

// Paystack Transfer + Refund require recipient creation + separate API calls.
// Left as clear TODOs — wire up when you enable Paystack as a live provider.
async function paystackTransfer(/* { gateway, ...args } */) {
  throw new Error(
    "Paystack transfers not implemented. See https://paystack.com/docs/transfers/single-transfers/",
  );
}

async function paystackRefund(/* { gateway, ...args } */) {
  throw new Error(
    "Paystack refunds not implemented. See https://paystack.com/docs/payments/refunds/",
  );
}

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════

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

/**
 * Send money out to a vendor (bank or MoMo).
 * Used by /vendor/payouts/request and the auto-payout scheduler.
 *
 * @param {object} options
 * @param {string} options.countryCode  - "GH" | "NG" | "INTL"
 * @param {number} options.amount       - decimal amount in currency's base unit
 * @param {string} options.currency     - "GHS" | "NGN" | "USD"
 * @param {string} options.narration    - shows on vendor's statement
 * @param {string} options.reference    - unique per attempt (your payoutRef)
 * @param {object} options.beneficiary  - { type: "momo" | "bank", ...details }
 *   For MoMo: { type: "momo", phone, network, name, email }
 *   For bank: { type: "bank", bankCode, accountNumber, name }
 * @returns {{ success, transferId, reference, status, complete }}
 */
export async function createTransfer({
  countryCode,
  amount,
  currency,
  narration,
  reference,
  beneficiary,
}) {
  const gateway = getGateway(countryCode);

  switch (gateway.provider) {
    case "paystack":
      return paystackTransfer({
        gateway,
        amount,
        currency,
        narration,
        reference,
        beneficiary,
      });
    case "flutterwave":
    default:
      return flutterwaveTransfer({
        gateway,
        amount,
        currency,
        narration,
        reference,
        beneficiary,
      });
  }
}

/**
 * Return money to the buyer's original payment method.
 * Used by /vendor/orders/:id/accept-refund.
 *
 * @param {object} options
 * @param {string} options.countryCode  - "GH" | "NG" | "INTL"
 * @param {string|number} options.flwTxId  - the id from verifyGatewayPayment (payment.id)
 * @param {number} [options.amount]     - omit for full refund
 * @param {string} [options.reason]     - vendor's reason, shown to FLW
 * @returns {{ success, refundId, status, amount }}
 */
export async function createRefund({ countryCode, flwTxId, amount, reason }) {
  const gateway = getGateway(countryCode);

  switch (gateway.provider) {
    case "paystack":
      return paystackRefund({ gateway, flwTxId, amount, reason });
    case "flutterwave":
    default:
      return flutterwaveRefund({ gateway, flwTxId, amount, reason });
  }
}

/**
 * Poll the status of a transfer (for stuck payouts / debugging).
 *
 * @param {object} options
 * @param {string} options.countryCode
 * @param {string|number} options.transferId  - from createTransfer result
 * @returns raw gateway data
 */
export async function getTransferStatus({ countryCode, transferId }) {
  const gateway = getGateway(countryCode);

  switch (gateway.provider) {
    case "paystack":
      throw new Error("Paystack transfer status lookup not implemented");
    case "flutterwave":
    default:
      return flutterwaveTransferStatus({ gateway, transferId });
  }
}
