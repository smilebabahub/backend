// lib/clozarGateway.js
//
// Clozar Payment adapter. Same shape as lib/paymentGateway.js so the
// controllers look identical to your Flutterwave ones.
//
// ═══════════════════════════════════════════════════════════════════════
//  ⚠️  FOUR THINGS TO CONFIRM AGAINST CLOZAR'S DOCS
//
//  Everything outside the CLOZAR_SPEC block below is provider-agnostic and
//  won't change. Fill these in and the integration is done:
//
//    1. Endpoint paths            — createSession / verify
//    2. Request field names       — what they call amount, currency, ref…
//    3. Response field names      — where the checkout URL and status live
//    4. Webhook signature scheme  — HMAC-SHA256/512? which header? raw body?
//
//  Placeholders below follow the most common conventions (and match how
//  Flutterwave and Paystack behave), so there's a decent chance they're
//  already right — but verify before going live with real money.
// ═══════════════════════════════════════════════════════════════════════

import axios from "axios";
import crypto from "crypto";

// ─── Config (lazy — dotenv has loaded by call time) ──────────────────
function cfg() {
  const isLive = process.env.CLOZAR_MODE === "live";
  return {
    baseUrl: isLive
      ? (process.env.CLOZAR_API_URL ?? "https://api.clozar.com/v1")
      : (process.env.CLOZAR_API_URL_TEST ??
        "https://sandbox-api.clozar.com/v1"),
    secretKey: process.env.CLOZAR_SECRET_KEY ?? "",
    publicKey: process.env.CLOZAR_PUBLIC_KEY ?? "",
    webhookSecret: process.env.CLOZAR_WEBHOOK_SECRET ?? "",
    isLive,
  };
}

function assertConfigured() {
  const { secretKey } = cfg();
  if (!secretKey) {
    throw new Error(
      "Clozar not configured. Set CLOZAR_SECRET_KEY in your environment.",
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  CLOZAR_SPEC — everything provider-specific lives here
// ═══════════════════════════════════════════════════════════════════════
const CLOZAR_SPEC = {
  endpoints: {
    createSession: "/checkout/sessions", // ← CONFIRM
    verify: (ref) => `/transactions/${ref}`, // ← CONFIRM
  },

  /** Map our transfer into Clozar's create-session body. ← CONFIRM names */
  buildSessionPayload({
    amount,
    currency,
    reference,
    redirectUrl,
    callbackUrl,
    customer,
    description,
    metadata,
  }) {
    return {
      amount: Number(amount),
      currency,
      reference,
      redirect_url: redirectUrl,
      callback_url: callbackUrl,
      customer: {
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
      },
      description,
      metadata,
      // Branding on the hosted page — Clozar shows "Paying SmileBabaHub"
      merchant_name: "SmileBabaHub",
      logo_url: "https://www.smilebabahub.com/logo.png",
    };
  },

  /** Pull the checkout URL + session id out of their response. ← CONFIRM */
  parseSessionResponse(body) {
    const d = body?.data ?? body ?? {};
    return {
      checkoutUrl: d.checkout_url ?? d.payment_url ?? d.link ?? d.url,
      sessionId: d.session_id ?? d.id ?? d.reference,
      raw: d,
    };
  },

  /** Normalise their verify response to our common shape. ← CONFIRM */
  parseVerifyResponse(body) {
    const d = body?.data ?? body ?? {};
    const rawStatus = String(d.status ?? "").toLowerCase();

    return {
      status: ["success", "successful", "completed", "paid"].includes(rawStatus)
        ? "successful"
        : ["pending", "processing", "ongoing"].includes(rawStatus)
          ? "pending"
          : "failed",
      rawStatus,
      // charged_amount is what actually left the customer's account
      amount: Number(d.charged_amount ?? d.amount_paid ?? d.amount ?? 0),
      currency: d.currency,
      reference: d.reference ?? d.tx_ref ?? d.merchant_reference,
      clozarRef: d.id ?? d.transaction_id ?? d.reference,
      method: d.payment_method ?? d.channel,
      metadata: d.metadata ?? d.meta ?? {},
      raw: d,
    };
  },

  /** Webhook signature check. ← CONFIRM header name + algorithm */
  verifySignature({ headers, rawBody, secret }) {
    const sent =
      headers["x-clozar-signature"] ??
      headers["clozar-signature"] ??
      headers["verif-hash"];
    if (!sent || !secret) return false;

    // Simple shared-secret style (Flutterwave does this)
    if (sent === secret) return true;

    // HMAC style (Paystack does this)
    const payload = Buffer.isBuffer(rawBody)
      ? rawBody.toString("utf8")
      : typeof rawBody === "string"
        ? rawBody
        : JSON.stringify(rawBody);

    for (const algo of ["sha512", "sha256"]) {
      const hash = crypto
        .createHmac(algo, secret)
        .update(payload)
        .digest("hex");
      // timingSafeEqual needs equal lengths
      if (hash.length === sent.length) {
        try {
          if (crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(sent))) {
            return true;
          }
        } catch {
          /* length mismatch — fall through */
        }
      }
    }
    return false;
  },

  /** Is this webhook event a completed payin? ← CONFIRM event names */
  isPaymentSuccessEvent(payload) {
    const event = String(payload?.event ?? payload?.type ?? "").toLowerCase();
    const status = String(
      payload?.data?.status ?? payload?.status ?? "",
    ).toLowerCase();

    const eventOk =
      !event ||
      event.includes("success") ||
      event.includes("completed") ||
      event.includes("charge") ||
      event.includes("payment");
    const statusOk = ["success", "successful", "completed", "paid"].includes(
      status,
    );

    return eventOk && statusOk;
  },
};
// ═══════════════════════════════════════════════════════════════════════
//  END CLOZAR_SPEC — nothing below is provider-specific
// ═══════════════════════════════════════════════════════════════════════

function client() {
  const { baseUrl, secretKey } = cfg();
  return axios.create({
    baseURL: baseUrl,
    timeout: 30_000,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Create a hosted checkout session.
 * @returns {{ checkoutUrl: string, sessionId: string, raw: object }}
 */
export async function createCheckoutSession({
  amount,
  currency,
  reference,
  redirectUrl,
  callbackUrl,
  customer,
  description = "SmileBaba Money transfer",
  metadata = {},
}) {
  assertConfigured();

  if (!reference) throw new Error("reference is required");
  if (!(Number(amount) > 0))
    throw new Error("amount must be greater than zero");

  const payload = CLOZAR_SPEC.buildSessionPayload({
    amount,
    currency,
    reference,
    redirectUrl,
    callbackUrl,
    customer,
    description,
    metadata,
  });

  try {
    const { data } = await client().post(
      CLOZAR_SPEC.endpoints.createSession,
      payload,
    );
    const parsed = CLOZAR_SPEC.parseSessionResponse(data);

    if (!parsed.checkoutUrl) {
      console.error(
        "[clozar] no checkout URL in response:",
        JSON.stringify(data),
      );
      throw new Error("Clozar did not return a checkout URL");
    }
    return parsed;
  } catch (err) {
    const detail =
      err.response?.data?.message ?? err.response?.data?.error ?? err.message;
    console.error("[clozar:createCheckoutSession]", detail);
    throw new Error(
      typeof detail === "string" ? detail : "Checkout session failed",
    );
  }
}

/**
 * Verify a payment by our reference (or Clozar's).
 * @returns normalised { status, amount, currency, reference, clozarRef, … }
 */
export async function verifyPayment({ reference }) {
  assertConfigured();
  if (!reference) throw new Error("reference is required");

  try {
    const { data } = await client().get(
      CLOZAR_SPEC.endpoints.verify(reference),
    );
    return CLOZAR_SPEC.parseVerifyResponse(data);
  } catch (err) {
    // A 404 means "not paid yet" far more often than "broken"
    if (err.response?.status === 404) {
      return { status: "pending", rawStatus: "not_found", amount: 0 };
    }
    const detail = err.response?.data?.message ?? err.message;
    console.error("[clozar:verifyPayment]", detail);
    throw new Error(
      typeof detail === "string" ? detail : "Verification failed",
    );
  }
}

/** Verify a webhook came from Clozar. Pass the RAW body. */
export function verifyWebhookSignature({ headers, rawBody }) {
  const { webhookSecret } = cfg();
  if (!webhookSecret) {
    console.warn("[clozar] CLOZAR_WEBHOOK_SECRET not set — rejecting webhook");
    return false;
  }
  return CLOZAR_SPEC.verifySignature({
    headers,
    rawBody,
    secret: webhookSecret,
  });
}

/** Is this webhook payload a successful payin? */
export function isPaymentSuccessEvent(payload) {
  return CLOZAR_SPEC.isPaymentSuccessEvent(payload);
}

/** Normalise a webhook payload the same way verify does. */
export function parseWebhookPayload(payload) {
  return CLOZAR_SPEC.parseVerifyResponse(payload);
}

/** Sandbox vs live — useful for showing a test banner in the app. */
export function isLiveMode() {
  return cfg().isLive;
}
