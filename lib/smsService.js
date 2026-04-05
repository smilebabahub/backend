// lib/smsService.js
// SMS notifications via Termii (supports Ghana + Nigeria).
// Termii is a leading African SMS gateway — works for both GH and NG numbers.
//
// Required env vars:
//   TERMII_API_KEY   — from https://termii.com
//   TERMII_SENDER_ID — your approved sender ID e.g. "SmileBaba" (max 11 chars)
//
// Fallback: if TERMII_API_KEY is not set, SMS is logged to console only
// so the app never crashes due to missing SMS config.

const TERMII_URL = "https://api.ng.termii.com/api/sms/send";
const SENDER_ID = process.env.TERMII_SENDER_ID || "SmileBaba";

/**
 * Format a phone number to E.164 international format.
 * Handles:
 *   Ghana:   0244123456 → +233244123456
 *   Nigeria: 08012345678 → +2348012345678
 *   Already international: +233... / +234... → unchanged
 */
function toE164(phone) {
  const clean = String(phone).replace(/[\s\-().]/g, "");

  if (clean.startsWith("+")) return clean; // already E.164

  // Ghana: 0xx → +233xx
  if (/^0[2-9]\d{7,8}$/.test(clean)) {
    return "+233" + clean.slice(1);
  }

  // Nigeria: 0xx → +234xx
  if (/^0[7-9]\d{9}$/.test(clean)) {
    return "+234" + clean.slice(1);
  }

  // Bare country code without +
  if (clean.startsWith("233") || clean.startsWith("234")) {
    return "+" + clean;
  }

  return "+" + clean; // best effort
}

/**
 * Send an SMS via Termii.
 * @param {string} to   — recipient phone number (any format)
 * @param {string} body — message text (max 160 chars for single SMS)
 * @returns {Promise<void>}
 */
export async function sendSMS(to, body) {
  const apiKey = process.env.TERMII_API_KEY;

  if (!apiKey) {
    // No SMS key configured — log and skip (never crash the app)
    console.log(`[SMS - dev] To: ${to}\n${body}\n`);
    return;
  }

  const number = toE164(to);

  const payload = {
    to: number,
    from: SENDER_ID,
    sms: body.slice(0, 160), // keep within single SMS
    type: "plain",
    channel: "generic",
    api_key: apiKey,
  };

  const res = await fetch(TERMII_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Termii SMS failed ${res.status}: ${text}`);
  }

  const data = await res.json().catch(() => ({}));
  console.log(`[SMS] Sent to ${number}: ${data.message || "ok"}`);
}
