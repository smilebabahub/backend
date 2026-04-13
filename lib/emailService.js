// lib/emailService.js
// Centralised email service for SmileBaba Hub.
// Uses nodemailer (already installed). Sends to both the user AND admin.
//
// Env vars required:
//   EMAIL_USER         — Gmail address used as sender (e.g. noreply@smilebabahub.com)
//   EMAIL_PASS         — Gmail app password (not account password)
//   ADMIN_EMAIL        — Admin inbox (e.g. admin@smilebabahub.com)
//
// Events handled:
//   1. User registration
//   2. Subscription activated
//   3. Ad boost activated
//   4. Marketer registration

import nodemailer from "nodemailer";

// ── Transporter (created once, reused) ────────────────────────────────────────
// Single pooled transporter — created once, reused across all sends.
// pool:true        → one persistent TCP connection to Gmail instead of
//                    opening a new one per email (main cause of 421 errors)
// maxConnections:1 → Gmail allows 1 concurrent SMTP session per account
// maxMessages:10   → rotate connection after 10 msgs to prevent idle timeout
// rateLimit/rateDelta → hard cap at 1 msg / 2 s = 30/min, well under
//                    Gmail's limits (500/day free, 2000/day Workspace)
let _transporter = null;

function createTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    service: "gmail",
    pool: true,
    maxConnections: 1,
    maxMessages: 10,
    rateDelta: 2000, // window in ms
    rateLimit: 1, // max messages per window
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
  // Log transporter errors so they surface in Render logs
  _transporter.on("error", (err) => {
    console.error("[emailService] SMTP pool error:", err.message);
    _transporter = null; // force reconnect on next send
  });
  return _transporter;
}

// ── Brand colors ──────────────────────────────────────────────────────────────
const BRAND = {
  yellow: "#ffc105",
  black: "#111111",
  white: "#ffffff",
  gray: "#f5f5f5",
  textDark: "#1a1a1a",
  textMuted: "#666666",
  border: "#e5e5e5",
};

// ── Base HTML wrapper ─────────────────────────────────────────────────────────
function baseTemplate({ title, previewText, body }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.gray};font-family:'Helvetica Neue',Arial,sans-serif;">
  <!-- Preview text (hidden) -->
  <div style="display:none;max-height:0;overflow:hidden;color:${BRAND.gray};">
    ${previewText}
  </div>

  <table width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.gray};padding:32px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
        style="background:${BRAND.white};border-radius:16px;overflow:hidden;
               border:1px solid ${BRAND.border};max-width:600px;width:100%;">

        <!-- Header -->
        <tr>
          <td style="background:${BRAND.black};padding:28px 40px;text-align:center;">
            <span style="font-size:26px;font-weight:900;color:${BRAND.yellow};
              letter-spacing:-0.5px;">SmileBaba</span>
            <span style="font-size:26px;font-weight:900;color:${BRAND.white};
              letter-spacing:-0.5px;"> Hub</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:40px;">
            ${body}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:${BRAND.gray};padding:24px 40px;
            border-top:1px solid ${BRAND.border};text-align:center;">
            <p style="margin:0;font-size:12px;color:${BRAND.textMuted};line-height:1.6;">
              SmileBaba Hub &mdash; Buy &amp; Sell in Ghana &amp; Nigeria<br/>
              <a href="https://smilebabahub.com" style="color:${BRAND.yellow};
                text-decoration:none;">smilebabahub.com</a>
              &nbsp;&middot;&nbsp;
              <a href="mailto:support@smilebabahub.com" style="color:${BRAND.textMuted};
                text-decoration:none;">support@smilebabahub.com</a>
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ── Shared UI blocks ─────────────────────────────────────────────────────────
function heading(text) {
  return `<h1 style="margin:0 0 8px;font-size:24px;font-weight:900;
    color:${BRAND.textDark};line-height:1.2;">${text}</h1>`;
}

function subheading(text) {
  return `<p style="margin:0 0 24px;font-size:15px;color:${BRAND.textMuted};
    line-height:1.6;">${text}</p>`;
}

function infoBox(rows) {
  const rowHtml = rows
    .map(
      ([label, value]) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid ${BRAND.border};
        font-size:13px;color:${BRAND.textMuted};width:40%;">${label}</td>
      <td style="padding:10px 0;border-bottom:1px solid ${BRAND.border};
        font-size:13px;font-weight:700;color:${BRAND.textDark};text-align:right;">
        ${value}
      </td>
    </tr>`,
    )
    .join("");

  return `<table width="100%" cellpadding="0" cellspacing="0"
    style="border:1px solid ${BRAND.border};border-radius:12px;
           overflow:hidden;margin:20px 0;border-collapse:collapse;">
    <tbody>${rowHtml}</tbody>
  </table>`;
}

function ctaButton(text, href) {
  return `<div style="text-align:center;margin:28px 0 0;">
    <a href="${href}" style="display:inline-block;background:${BRAND.yellow};
      color:${BRAND.black};font-weight:900;font-size:15px;padding:14px 36px;
      border-radius:50px;text-decoration:none;letter-spacing:0.3px;">
      ${text}
    </a>
  </div>`;
}

function divider() {
  return `<hr style="border:none;border-top:1px solid ${BRAND.border};margin:28px 0;" />`;
}

function adminBadge() {
  return `<div style="background:#fff3cd;border:1px solid #ffc105;border-radius:8px;
    padding:10px 16px;margin:0 0 24px;font-size:13px;color:#856404;font-weight:600;">
    Admin notification &mdash; SmileBaba Hub internal alert
  </div>`;
}

// ── Core send helper ──────────────────────────────────────────────────────────
// Retry helper — waits ms milliseconds
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Global lock-out: if Gmail returns 454 (too many logins) we stop all sends
// for LOCKOUT_MS to let the account cool down before retrying.
let _lockedUntil = 0;

// send() with back-off retry on recoverable Gmail errors.
// 421 = temporary block     → retry after 10 s / 30 s (max 3 attempts)
// 454 = too many logins     → pause ALL sends for 5 min, then retry once
// anything else             → log and skip (don't crash the flow)
async function send({ to, subject, html }, attempt = 1) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn(
      "[emailService] EMAIL_USER or EMAIL_PASS not set — email skipped",
    );
    return;
  }

  // Honour the global lock-out
  const now = Date.now();
  if (now < _lockedUntil) {
    const remaining = Math.ceil((_lockedUntil - now) / 1000);
    console.warn(
      `[emailService] Gmail locked out — skipping send to ${to} (${remaining}s remaining)`,
    );
    return;
  }

  try {
    const transporter = createTransporter();
    await transporter.sendMail({
      from: `"SmileBaba Hub" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html,
    });
  } catch (err) {
    const code = err.responseCode ?? 0;
    const msg = err.message ?? "";
    const is421 = code === 421 || msg.includes("421");
    const is454 =
      code === 454 || msg.includes("454") || msg.includes("Too many login");

    if (is454) {
      // Lock out all sends for 5 minutes — do NOT reset the transporter here
      // (resetting causes another auth attempt which deepens the lockout)
      const LOCKOUT_MS = 5 * 60 * 1000;
      _lockedUntil = Date.now() + LOCKOUT_MS;
      console.error(
        `[emailService] Gmail 454 login lockout — pausing all sends for 5 min. ` +
          `Check EMAIL_PASS is a valid App Password (not your Gmail password).`,
      );
      return;
    }

    if (is421 && attempt < 3) {
      const delay = attempt === 1 ? 15_000 : 45_000;
      console.warn(
        `[emailService] Gmail 421 temporary block — retrying in ${delay / 1000}s ` +
          `(attempt ${attempt}/3) to: ${to}`,
      );
      // Close and recreate the pool so the retry uses a fresh TCP connection
      if (_transporter) {
        try {
          _transporter.close();
        } catch (_) {}
        _transporter = null;
      }
      await wait(delay);
      return send({ to, subject, html }, attempt + 1);
    }

    // Non-retryable — log and continue; never throw
    console.error(
      `[emailService] Send failed (attempt ${attempt}):`,
      err.message,
    );
  }
}

const ADMIN = () => process.env.ADMIN_EMAIL || process.env.EMAIL_USER;
const APP = "https://smilebabahub.com";

// ═══════════════════════════════════════════════════════════════════════════════
// 1. USER REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════
export async function sendRegistrationEmails({
  username,
  email,
  country,
  city,
}) {
  const displayName = username || email;
  const location = [city, country].filter(Boolean).join(", ") || "Unknown";

  // ── To user ──
  await send({
    to: email,
    subject: "Welcome to SmileBaba Hub!",
    html: baseTemplate({
      title: "Welcome to SmileBaba Hub",
      previewText: "Your account is ready. Start buying and selling today.",
      body: `
        ${heading("Welcome to SmileBaba Hub!")}
        ${subheading(`Hi ${displayName}, your account has been created successfully.`)}
        <p style="font-size:15px;color:${BRAND.textDark};line-height:1.7;margin:0 0 20px;">
          You can now browse thousands of listings across Ghana and Nigeria,
          contact sellers, and subscribe to a vendor plan to start selling.
        </p>
        ${infoBox([
          ["Username", displayName],
          ["Email", email],
          ["Location", location],
          [
            "Joined",
            new Date().toLocaleDateString("en-GH", { dateStyle: "long" }),
          ],
        ])}
        ${ctaButton("Browse marketplace", `${APP}/marketPlace`)}
        ${divider()}
        <p style="font-size:13px;color:${BRAND.textMuted};line-height:1.6;margin:0;">
          Want to sell? Subscribe to a vendor plan to post listings, boost products,
          and reach buyers in your country.
          <a href="${APP}/subscribe" style="color:${BRAND.yellow};font-weight:700;">
            View plans &rarr;
          </a>
        </p>
      `,
    }),
  });

  // ── To admin ──
  await send({
    to: ADMIN(),
    subject: `New user registered: ${displayName}`,
    html: baseTemplate({
      title: "New User Registration",
      previewText: `${displayName} just signed up on SmileBaba Hub.`,
      body: `
        ${adminBadge()}
        ${heading("New User Registration")}
        ${subheading("A new user has created an account.")}
        ${infoBox([
          ["Username", displayName],
          ["Email", email],
          ["Location", location],
          ["Time", new Date().toLocaleString("en-GH")],
        ])}
        ${ctaButton("View in admin", `${APP}/admin/users`)}
      `,
    }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 2. SUBSCRIPTION ACTIVATED
// ═══════════════════════════════════════════════════════════════════════════════
export async function sendSubscriptionEmails({
  username,
  email,
  planTitle,
  billingCycle,
  amount,
  currency,
  expiresAt,
}) {
  const sym = currency === "NGN" ? "₦" : "₵";
  const displayName = username || email;
  const expiry = new Date(expiresAt).toLocaleDateString("en-GH", {
    dateStyle: "long",
  });
  const price = `${sym}${Number(amount).toLocaleString()}`;

  // ── To user ──
  await send({
    to: email,
    subject: `Your ${planTitle} subscription is active!`,
    html: baseTemplate({
      title: "Subscription Activated",
      previewText: `Your ${planTitle} is now active. Start posting listings!`,
      body: `
        ${heading("Subscription Activated!")}
        ${subheading(`Hi ${displayName}, your subscription is live and ready to use.`)}
        <p style="font-size:15px;color:${BRAND.textDark};line-height:1.7;margin:0 0 20px;">
          You now have full vendor access. Post unlimited listings, boost your ads
          to the top of search results, and reach buyers across your country.
        </p>
        ${infoBox([
          ["Plan", planTitle],
          [
            "Billing",
            `${billingCycle.charAt(0).toUpperCase() + billingCycle.slice(1)}ly`,
          ],
          ["Amount paid", price],
          ["Currency", currency],
          ["Active until", expiry],
        ])}
        ${ctaButton("Go to vendor dashboard", `${APP}/vendor/dashboard`)}
        ${divider()}
        <p style="font-size:13px;color:${BRAND.textMuted};line-height:1.6;margin:0;">
          Questions? Email us at
          <a href="mailto:support@smilebabahub.com"
            style="color:${BRAND.yellow};font-weight:700;">
            support@smilebabahub.com
          </a>
        </p>
      `,
    }),
  });

  // ── To admin ──
  await send({
    to: ADMIN(),
    subject: `New subscription: ${displayName} — ${planTitle}`,
    html: baseTemplate({
      title: "New Subscription",
      previewText: `${displayName} just subscribed to ${planTitle}.`,
      body: `
        ${adminBadge()}
        ${heading("New Subscription")}
        ${subheading(`${displayName} just activated a vendor subscription.`)}
        ${infoBox([
          ["Vendor", displayName],
          ["Email", email],
          ["Plan", planTitle],
          ["Billing", billingCycle],
          ["Amount", price],
          ["Currency", currency],
          ["Expires", expiry],
          ["Time", new Date().toLocaleString("en-GH")],
        ])}
        ${ctaButton("View in admin", `${APP}/admin/subscriptions`)}
      `,
    }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 3. AD BOOST ACTIVATED
// ═══════════════════════════════════════════════════════════════════════════════
export async function sendBoostEmails({
  username,
  email,
  adTitle,
  adId,
  tier,
  tierLabel,
  days,
  amount,
  currency,
}) {
  const sym = currency === "NGN" ? "₦" : "₵";
  const displayName = username || email;
  const price = `${sym}${Number(amount).toLocaleString()}`;

  // ── To user ──
  await send({
    to: email,
    subject: `Your ad is now boosted: ${adTitle}`,
    html: baseTemplate({
      title: "Ad Boost Activated",
      previewText: `Your ad "${adTitle}" is now boosted for ${days} days.`,
      body: `
        ${heading("Your Ad is Now Boosted!")}
        ${subheading(`Hi ${displayName}, your ad is now getting priority placement.`)}
        <p style="font-size:15px;color:${BRAND.textDark};line-height:1.7;margin:0 0 20px;">
          Your boosted ad will appear higher in search results and reach more buyers
          across your country for the next ${days} days.
        </p>
        ${infoBox([
          ["Ad title", adTitle],
          ["Boost tier", tierLabel],
          ["Duration", `${days} days`],
          ["Amount paid", price],
          [
            "Expires",
            new Date(Date.now() + days * 86400000).toLocaleDateString("en-GH", {
              dateStyle: "long",
            }),
          ],
        ])}
        ${ctaButton("View your ad", `${APP}/ads/${adId}`)}
        ${divider()}
        <p style="font-size:13px;color:${BRAND.textMuted};line-height:1.6;margin:0;">
          Want to boost more ads? Visit your
          <a href="${APP}/vendor/boost" style="color:${BRAND.yellow};font-weight:700;">
            vendor boost page &rarr;
          </a>
        </p>
      `,
    }),
  });

  // ── To admin ──
  await send({
    to: ADMIN(),
    subject: `Ad boost: ${displayName} — ${tierLabel}`,
    html: baseTemplate({
      title: "Ad Boost Activated",
      previewText: `${displayName} boosted an ad (${tierLabel}).`,
      body: `
        ${adminBadge()}
        ${heading("Ad Boost Activated")}
        ${subheading(`${displayName} just paid for an ad boost.`)}
        ${infoBox([
          ["Vendor", displayName],
          ["Email", email],
          ["Ad title", adTitle],
          ["Boost tier", tierLabel],
          ["Duration", `${days} days`],
          ["Amount", price],
          ["Currency", currency],
          ["Time", new Date().toLocaleString("en-GH")],
        ])}
        ${ctaButton("View ad", `${APP}/ads/${adId}`)}
      `,
    }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 4. MARKETER REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════════
export async function sendMarketerRegistrationEmails({
  name,
  email,
  referralCode,
}) {
  // ── To marketer ──
  await send({
    to: email,
    subject: "Welcome to the SmileBaba Marketer Program!",
    html: baseTemplate({
      title: "Marketer Registration",
      previewText: `Your referral code is ${referralCode}. Start earning today!`,
      body: `
        ${heading("Welcome to the Marketer Program!")}
        ${subheading(`Hi ${name}, you're officially a SmileBaba marketer.`)}
        <p style="font-size:15px;color:${BRAND.textDark};line-height:1.7;margin:0 0 20px;">
          Share your referral code with vendors and earn
          <strong>15% commission</strong> on every subscription they purchase.
          Vendors who use your code also get a 15% discount — a win for everyone.
        </p>
        ${infoBox([
          ["Your name", name],
          ["Email", email],
          [
            "Referral code",
            `<span style="font-family:monospace;font-size:15px;
                               font-weight:900;color:${BRAND.yellow};">${referralCode}</span>`,
          ],
          ["Commission", "15% per referred subscription"],
          ["Vendor discount", "15% off their plan"],
        ])}
        <div style="background:${BRAND.black};border-radius:12px;padding:20px;
          text-align:center;margin:20px 0;">
          <p style="margin:0 0 8px;font-size:13px;color:#999;">Your referral link</p>
          <p style="margin:0;font-family:monospace;font-size:14px;
            color:${BRAND.yellow};word-break:break-all;">
            https://smilebabahub.com/subscribe?ref=${referralCode}
          </p>
        </div>
        ${ctaButton("View your dashboard", `${APP}/marketer/dashboard`)}
        ${divider()}
        <p style="font-size:13px;color:${BRAND.textMuted};line-height:1.6;margin:0;">
          Share your code on WhatsApp, social media, or directly with vendors.
          You get paid every time someone subscribes using your link.
        </p>
      `,
    }),
  });

  // ── To admin ──
  await send({
    to: ADMIN(),
    subject: `New marketer: ${name}`,
    html: baseTemplate({
      title: "New Marketer Registered",
      previewText: `${name} just joined the SmileBaba marketer program.`,
      body: `
        ${adminBadge()}
        ${heading("New Marketer Registered")}
        ${subheading(`${name} just signed up as a SmileBaba marketer.`)}
        ${infoBox([
          ["Name", name],
          ["Email", email],
          ["Referral code", referralCode],
          ["Time", new Date().toLocaleString("en-GH")],
        ])}
        ${ctaButton("View in admin", `${APP}/admin/marketers`)}
      `,
    }),
  });
}

// ── Admin direct / bulk email ──────────────────────────────────────────────
export async function sendAdminDirectEmail({ to, name, subject, message }) {
  const html = baseTemplate({
    title: subject,
    previewText: message.slice(0, 100),
    body: `
      ${heading(`Hi ${name || "there"},`)}
      <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#333;">
        ${message.replace(/\n/g, "<br/>")}
      </p>
      ${divider()}
      <p style="margin:0;font-size:13px;color:#888;text-align:center;">
        This message was sent by the SmileBaba admin team.<br/>
        Questions? Reply to this email or visit
        <a href="https://smilebabahub.com" style="color:#ffc105;">smilebabahub.com</a>
      </p>
    `,
  });
  await send({ to, subject, html });
}
