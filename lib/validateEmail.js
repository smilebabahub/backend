// lib/validateEmail.js
// Three-layer email validation:
//   1. Regex — correct format
//   2. Disposable domain blocklist — rejects throwaway addresses
//   3. DNS MX lookup — domain actually has mail servers
//
// No external packages needed — uses Node's built-in dns/promises module.
// Returns { valid: boolean, reason?: string }

import { promises as dns } from "dns";

// ── Layer 1: format regex ──────────────────────────────────────────────────
// RFC 5322 simplified — rejects obvious junk without false positives.
const EMAIL_REGEX = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

// ── Layer 2: disposable / throwaway domain blocklist ──────────────────────
// Add more as needed. Keep lowercase.
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamail.de",
  "guerrillamail.info",
  "throwam.com",
  "throwaway.email",
  "trashmail.com",
  "trashmail.me",
  "trashmail.net",
  "trashmail.at",
  "trashmail.io",
  "yopmail.com",
  "yopmail.fr",
  "cool.fr.nf",
  "jetable.fr.nf",
  "nospam.ze.tc",
  "nomail.xl.cx",
  "mega.zik.dj",
  "speed.1s.fr",
  "courriel.fr.nf",
  "moncourrier.fr.nf",
  "tempr.email",
  "temp-mail.org",
  "temp-mail.io",
  "temp-mail.de",
  "tempmail.com",
  "tempmail.net",
  "tempmail.de",
  "tempmail.us",
  "10minutemail.com",
  "10minutemail.net",
  "10minutemail.org",
  "10minutemail.co.uk",
  "10minutemail.de",
  "10minutemail.info",
  "sharklasers.com",
  "guerrillamailblock.com",
  "grr.la",
  "spam4.me",
  "spamgourmet.com",
  "spamgourmet.net",
  "spamgourmet.org",
  "maildrop.cc",
  "dispostable.com",
  "discard.email",
  "discardmail.com",
  "spamhereplease.com",
  "spamfree24.org",
  "mailnull.com",
  "mailexpire.com",
  "fakeinbox.com",
  "fakeinbox.org",
  "mailnesia.com",
  "getonemail.com",
  "getonemail.net",
  "filzmail.com",
  "meltmail.com",
  "deadaddress.com",
  "incognitomail.com",
  "mytrashmail.com",
  "mailscrap.com",
  "spambox.us",
  "spambox.info",
  "spamcero.com",
  "dispostable.me",
  "no-spam.ws",
  "getnada.com",
  "nada.email",
]);

// ── Layer 3: DNS MX check ──────────────────────────────────────────────────
async function hasMxRecord(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return records && records.length > 0;
  } catch {
    return false;
  }
}

// ── Main export ────────────────────────────────────────────────────────────
/**
 * validateEmail(email) → { valid: boolean, reason?: string }
 *
 * Runs synchronous checks first (fast), then async DNS (slightly slower).
 * Always resolves — never throws.
 *
 * @param {string} email
 * @returns {Promise<{ valid: boolean, reason?: string }>}
 */
export async function validateEmail(email) {
  if (!email || typeof email !== "string") {
    return { valid: false, reason: "Email is required" };
  }

  const trimmed = email.trim().toLowerCase();

  // 1. Format
  if (!EMAIL_REGEX.test(trimmed)) {
    return { valid: false, reason: "Please enter a valid email address" };
  }

  const domain = trimmed.split("@")[1];

  // 2. Disposable
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return {
      valid: false,
      reason:
        "Disposable email addresses are not allowed. Please use your real email.",
    };
  }

  // 3. MX record
  const hasMx = await hasMxRecord(domain);
  if (!hasMx) {
    return {
      valid: false,
      reason: `The domain "${domain}" does not appear to accept emails. Please check your email address.`,
    };
  }

  return { valid: true };
}
