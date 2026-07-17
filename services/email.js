// backend/services/email.js
//
// Email service. Uses nodemailer + SMTP so it works with Gmail, SendGrid,
// Mailgun, Resend, or any SMTP provider. Never crashes if unconfigured —
// just logs a warning and moves on, so submissions still succeed.
//
// Required env vars (all optional — email quietly disables without them):
//   SMTP_HOST      e.g. smtp.gmail.com  |  smtp-relay.brevo.com  |  smtp.resend.com
//   SMTP_PORT      e.g. 587
//   SMTP_USER      e.g. hello@smilebabahub.com  |  API key username
//   SMTP_PASS      SMTP password or API key
//   SMTP_SECURE    "true" for port 465, "false" (default) for port 587 with STARTTLS
//   EMAIL_FROM     e.g. "SmileBabaHub <hello@smilebabahub.com>"
//   FRONTEND_URL   e.g. https://smilebabahub.com (used in email CTAs)

import nodemailer from "nodemailer";

const FRONTEND_URL = process.env.FRONTEND_URL || "https://smilebabahub.com";
const EMAIL_FROM =
  process.env.EMAIL_FROM || "SmileBabaHub <hello@smilebabahub.com>";

// ─── Transporter singleton ────────────────────────────────────────────
let _transporter = null;
let _configured = null;

function getTransporter() {
  if (_configured === false) return null; // already known unconfigured
  if (_transporter) return _transporter;

  const { SMTP_HOST, SMTP_PORT, EMAIL_USER, EMAIL_PASS } = process.env;
  if (!SMTP_HOST || !EMAIL_USER || !EMAIL_PASS) {
    console.warn(
      "[email] SMTP not configured — emails will be logged but not sent.\n" +
        "         Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS to enable.",
    );
    _configured = false;
    return null;
  }

  _transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  _configured = true;
  return _transporter;
}

// ─── Low-level send ───────────────────────────────────────────────────
export async function sendEmail({ to, subject, html, text }) {
  const t = getTransporter();
  if (!t) {
    console.log(`[email] SKIPPED (unconfigured) → ${to} · ${subject}`);
    return { skipped: true };
  }
  try {
    const info = await t.sendMail({
      from: EMAIL_FROM,
      to,
      subject,
      html,
      text: text ?? stripHtml(html),
    });
    console.log(`[email] SENT → ${to} · ${subject} · ${info.messageId}`);
    return { messageId: info.messageId };
  } catch (err) {
    console.error(`[email] FAILED → ${to} · ${subject}:`, err.message);
    return { error: err.message };
  }
}

// ─── Base template (shared header/footer) ─────────────────────────────
const baseTemplate = (contentHtml) => `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width" />
    <title>SmileBabaHub</title>
  </head>
  <body style="margin:0;padding:0;background:#F9FAFB;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:white;border-radius:20px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.04);">
            <!-- Header -->
            <tr>
              <td style="background:#111827;padding:20px 24px;text-align:left;">
                <span style="font-size:20px;font-weight:900;color:#FFC105;letter-spacing:-0.5px;">Smile</span><span style="font-size:20px;font-weight:900;color:white;letter-spacing:-0.5px;">Baba</span><span style="font-size:20px;font-weight:900;color:#FFC105;letter-spacing:-0.5px;">Hub</span>
                <span style="font-size:20px;margin-left:4px;">😊</span>
              </td>
            </tr>
            <!-- Content -->
            <tr>
              <td style="padding:32px 24px;">
                ${contentHtml}
              </td>
            </tr>
            <!-- Footer -->
            <tr>
              <td style="background:#F9FAFB;padding:20px 24px;text-align:center;border-top:1px solid #E5E7EB;">
                <p style="margin:0;font-size:12px;color:#6B7280;">
                  Sent by <strong>SmileBabaHub</strong> · Africa's marketplace<br/>
                  Questions? Reply to this email or visit
                  <a href="${FRONTEND_URL}/help" style="color:#B45309;text-decoration:none;font-weight:bold;">help center</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

const fmtMoney = (amount, currency) => {
  const sym = currency === "NGN" ? "₦" : "GHC";
  return `${sym} ${Number(amount).toLocaleString()}`;
};

// ═══════════════════════════════════════════════════════════════════════
// 1) SUBMISSION CONFIRMATION
//    Sent right after user submits their video campaign.
// ═══════════════════════════════════════════════════════════════════════
export async function sendPromotionSubmittedEmail({ to, promotion }) {
  const content = `
    <p style="font-size:12px;font-weight:900;color:#B45309;letter-spacing:1px;margin:0 0 8px 0;">
      SUBMISSION RECEIVED ✓
    </p>
    <h1 style="font-size:26px;font-weight:900;color:#111827;margin:0 0 12px 0;line-height:1.2;">
      Thanks — we've got your campaign
    </h1>
    <p style="font-size:15px;color:#4B5563;line-height:1.6;margin:0 0 20px 0;">
      Hi ${escapeHtml(promotion.contactName || promotion.businessName || "there")}, thanks for choosing SmileBabaHub to promote your business.
      Our team will review your submission within <strong>24–48 hours</strong>. If everything looks good,
      you'll receive a follow-up email with a secure payment link.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;border-radius:12px;padding:16px;margin:0 0 20px 0;">
      <tr>
        <td style="padding:6px 0;font-size:12px;color:#6B7280;font-weight:bold;">CAMPAIGN</td>
        <td style="padding:6px 0;font-size:14px;color:#111827;font-weight:900;text-align:right;">${escapeHtml(promotion.title)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-size:12px;color:#6B7280;font-weight:bold;">PLAN</td>
        <td style="padding:6px 0;font-size:14px;color:#111827;font-weight:900;text-align:right;text-transform:capitalize;">${escapeHtml(promotion.tier)} · ${promotion.days} days</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-size:12px;color:#6B7280;font-weight:bold;">AMOUNT DUE (ON APPROVAL)</td>
        <td style="padding:6px 0;font-size:14px;color:#111827;font-weight:900;text-align:right;">${fmtMoney(promotion.amount, promotion.currency)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-size:12px;color:#6B7280;font-weight:bold;">REFERENCE</td>
        <td style="padding:6px 0;font-size:12px;color:#6B7280;text-align:right;font-family:monospace;">${promotion._id}</td>
      </tr>
    </table>

    <p style="font-size:13px;color:#4B5563;line-height:1.6;margin:0 0 24px 0;">
      <strong style="color:#111827;">What happens next</strong><br/>
      1. Our team reviews the video for quality and content compliance<br/>
      2. If approved, we email you a payment link — pay via card, mobile money, or bank transfer<br/>
      3. Once paid, your campaign goes live within 48 hours across the channels you selected
    </p>

    <div style="text-align:center;margin:0 0 8px 0;">
      <a href="${FRONTEND_URL}/promote/status/${promotion._id}"
         style="display:inline-block;background:#FFC105;color:#111827;font-weight:900;font-size:14px;padding:12px 24px;border-radius:12px;text-decoration:none;">
        View submission status
      </a>
    </div>
  `;

  return sendEmail({
    to,
    subject: `Submission received: ${promotion.title}`,
    html: baseTemplate(content),
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 2) APPROVAL + PAYMENT LINK
//    Sent when admin clicks "Send payment link".
// ═══════════════════════════════════════════════════════════════════════
export async function sendPromotionApprovedEmail({
  to,
  promotion,
  adminNotes,
}) {
  const payUrl = `${FRONTEND_URL}/promote/${promotion._id}/pay`;

  const content = `
    <p style="font-size:12px;font-weight:900;color:#059669;letter-spacing:1px;margin:0 0 8px 0;">
      ✓ APPROVED — READY TO PAY
    </p>
    <h1 style="font-size:26px;font-weight:900;color:#111827;margin:0 0 12px 0;line-height:1.2;">
      Great news — your campaign is approved 🎉
    </h1>
    <p style="font-size:15px;color:#4B5563;line-height:1.6;margin:0 0 20px 0;">
      We've reviewed your submission and it's cleared. Complete payment below and we'll get your
      campaign live within <strong>48 hours</strong>.
    </p>

    ${
      adminNotes
        ? `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FEF3C7;border-radius:12px;padding:16px;margin:0 0 20px 0;border:1px solid #FDE68A;">
        <tr>
          <td>
            <p style="font-size:10px;font-weight:900;color:#B45309;letter-spacing:1px;margin:0 0 4px 0;">NOTE FROM OUR TEAM</p>
            <p style="font-size:13px;color:#78350F;margin:0;line-height:1.5;">${escapeHtml(adminNotes)}</p>
          </td>
        </tr>
      </table>
    `
        : ""
    }

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F9FAFB;border-radius:12px;padding:16px;margin:0 0 20px 0;">
      <tr>
        <td style="padding:6px 0;font-size:12px;color:#6B7280;font-weight:bold;">CAMPAIGN</td>
        <td style="padding:6px 0;font-size:14px;color:#111827;font-weight:900;text-align:right;">${escapeHtml(promotion.title)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-size:12px;color:#6B7280;font-weight:bold;">PLAN</td>
        <td style="padding:6px 0;font-size:14px;color:#111827;font-weight:900;text-align:right;text-transform:capitalize;">${escapeHtml(promotion.tier)} · ${promotion.days} days</td>
      </tr>
      <tr>
        <td colspan="2" style="border-top:1px dashed #E5E7EB;padding:8px 0 0 0;"></td>
      </tr>
      <tr>
        <td style="padding:8px 0 0 0;font-size:14px;color:#111827;font-weight:900;">TOTAL DUE</td>
        <td style="padding:8px 0 0 0;font-size:20px;color:#B45309;font-weight:900;text-align:right;">${fmtMoney(promotion.amount, promotion.currency)}</td>
      </tr>
    </table>

    <div style="text-align:center;margin:0 0 20px 0;">
      <a href="${payUrl}"
         style="display:inline-block;background:#FFC105;color:#111827;font-weight:900;font-size:16px;padding:16px 32px;border-radius:14px;text-decoration:none;box-shadow:0 4px 12px rgba(255,193,5,0.3);">
        💳 Pay securely now →
      </a>
    </div>

    <p style="font-size:12px;color:#6B7280;text-align:center;margin:0 0 20px 0;">
      Payment powered by Flutterwave · Card, Mobile Money, Bank Transfer
    </p>

    <p style="font-size:12px;color:#9CA3AF;line-height:1.6;margin:0;">
      This payment link is unique to your campaign. If you didn't request this, ignore this email.<br/>
      Reference: <code style="font-family:monospace;color:#6B7280;">${promotion._id}</code>
    </p>
  `;

  return sendEmail({
    to,
    subject: `✓ Approved — pay to launch: ${promotion.title}`,
    html: baseTemplate(content),
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 3) CAMPAIGN GOES LIVE
//    Sent when admin clicks "Mark live now".
// ═══════════════════════════════════════════════════════════════════════
export async function sendPromotionLiveEmail({ to, promotion }) {
  const startDate = promotion.liveAt ? new Date(promotion.liveAt) : new Date();
  const endDate = promotion.expiresAt ? new Date(promotion.expiresAt) : null;
  const dateFmt = (d) =>
    d
      ? d.toLocaleDateString("en-GB", {
          day: "numeric",
          month: "long",
          year: "numeric",
        })
      : "—";

  const channelLabels = {
    tv: "📺 Smile Time TV",
    radio: "📻 Smile Radio",
    social: "📱 Social Media",
    web: "🌐 SmileBaba Hub homepage",
  };
  const channelList = (promotion.channels || [])
    .map((c) => channelLabels[c] || c)
    .map(
      (c) =>
        `<li style="padding:4px 0;font-size:14px;color:#111827;">${c}</li>`,
    )
    .join("");

  const content = `
    <p style="font-size:12px;font-weight:900;color:#DC2626;letter-spacing:1px;margin:0 0 8px 0;">
      🔴 YOUR CAMPAIGN IS LIVE
    </p>
    <h1 style="font-size:26px;font-weight:900;color:#111827;margin:0 0 12px 0;line-height:1.2;">
      You're on the air! 🚀
    </h1>
    <p style="font-size:15px;color:#4B5563;line-height:1.6;margin:0 0 20px 0;">
      Your video is now running across all the channels in your plan. Sit back and watch the views come in.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F0FDF4;border-radius:12px;padding:16px;margin:0 0 20px 0;border:1px solid #BBF7D0;">
      <tr>
        <td style="padding:6px 0;font-size:12px;color:#166534;font-weight:bold;">CAMPAIGN</td>
        <td style="padding:6px 0;font-size:14px;color:#111827;font-weight:900;text-align:right;">${escapeHtml(promotion.title)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-size:12px;color:#166534;font-weight:bold;">LIVE FROM</td>
        <td style="padding:6px 0;font-size:14px;color:#111827;font-weight:900;text-align:right;">${dateFmt(startDate)}</td>
      </tr>
      <tr>
        <td style="padding:6px 0;font-size:12px;color:#166534;font-weight:bold;">RUNS UNTIL</td>
        <td style="padding:6px 0;font-size:14px;color:#111827;font-weight:900;text-align:right;">${dateFmt(endDate)}</td>
      </tr>
    </table>

    <p style="font-size:14px;font-weight:900;color:#111827;margin:0 0 8px 0;">Where you're airing</p>
    <ul style="margin:0 0 24px 0;padding-left:20px;">${channelList}</ul>

    <div style="text-align:center;margin:0 0 8px 0;">
      <a href="${FRONTEND_URL}/promote/${promotion._id}"
         style="display:inline-block;background:#FFC105;color:#111827;font-weight:900;font-size:14px;padding:12px 24px;border-radius:12px;text-decoration:none;">
        👀 View your live campaign
      </a>
    </div>

    <p style="font-size:12px;color:#6B7280;text-align:center;margin:16px 0 0 0;">
      Analytics update daily. We'll send you a wrap-up report when your campaign ends.
    </p>
  `;

  return sendEmail({
    to,
    subject: `🔴 Live now: ${promotion.title}`,
    html: baseTemplate(content),
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 4) REJECTION (bonus — sent when admin rejects)
// ═══════════════════════════════════════════════════════════════════════
export async function sendPromotionRejectedEmail({ to, promotion, reason }) {
  const content = `
    <p style="font-size:12px;font-weight:900;color:#B91C1C;letter-spacing:1px;margin:0 0 8px 0;">
      SUBMISSION NEEDS REWORK
    </p>
    <h1 style="font-size:24px;font-weight:900;color:#111827;margin:0 0 12px 0;line-height:1.2;">
      Sorry — we can't run this campaign as-is
    </h1>
    <p style="font-size:15px;color:#4B5563;line-height:1.6;margin:0 0 20px 0;">
      Our review team looked at your submission and unfortunately we can't approve it in its current form.
    </p>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FEF2F2;border-radius:12px;padding:16px;margin:0 0 20px 0;border:1px solid #FECACA;">
      <tr>
        <td>
          <p style="font-size:10px;font-weight:900;color:#B91C1C;letter-spacing:1px;margin:0 0 4px 0;">REASON</p>
          <p style="font-size:14px;color:#7F1D1D;margin:0;line-height:1.5;">${escapeHtml(reason || "No reason provided.")}</p>
        </td>
      </tr>
    </table>

    <p style="font-size:14px;color:#4B5563;line-height:1.6;margin:0 0 20px 0;">
      You're welcome to submit a revised version anytime. If you have questions about what to fix,
      reply to this email and we'll walk you through it.
    </p>

    <div style="text-align:center;">
      <a href="${FRONTEND_URL}/promote/submit"
         style="display:inline-block;background:#FFC105;color:#111827;font-weight:900;font-size:14px;padding:12px 24px;border-radius:12px;text-decoration:none;">
        Submit a new campaign
      </a>
    </div>
  `;

  return sendEmail({
    to,
    subject: `Update on your submission: ${promotion.title}`,
    html: baseTemplate(content),
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
