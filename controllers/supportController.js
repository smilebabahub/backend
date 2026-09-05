// controllers/supportController.js
//
// Contact form and account deletion.
//
// Deletion is the one Google Play inspects, and it has a specific shape:
// the request has to be verifiable, because otherwise anyone who knows an
// email address can close the account behind it. So a request creates a
// token, emails it, and nothing is deleted until that token comes back.
//
// Both endpoints are public — the deletion page must work signed out, and
// someone locked out of their account is exactly who needs the contact
// form.

import crypto from "crypto";

import User from "../models/user.js";
import Order from "../models/orderModel.js";
import ContactMessage from "../models/contactMessageModel.js";
import DeletionRequest from "../models/deletionRequestModel.js";
import {
  sendContactEmails,
  sendDeletionConfirmEmail,
  sendDeletionScheduledEmail,
  sendDeletionCompleteEmail,
} from "../lib/emailService.js";

const SITE = (
  process.env.NEXT_PUBLIC_APP_URL ??
  process.env.FRONTEND_URL ??
  "https://www.smilebabahub.com"
).replace(/\/+$/, "");

/** Deletion completes this many days after confirmation — long enough to undo. */
const GRACE_DAYS = 30;

const clean = (v, max = 2000) =>
  typeof v === "string" ? v.trim().slice(0, max) : undefined;

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v ?? ""));

const shortRef = (id) => String(id).slice(-6).toUpperCase();

// ═══════════════════════════════════════════════════════════════════════
// POST /support/contact
// ═══════════════════════════════════════════════════════════════════════
export const submitContact = async (req, res) => {
  try {
    const topic = clean(req.body.topic, 40) ?? "general";
    const topicLabel = clean(req.body.topicLabel, 80);
    const name = clean(req.body.name, 120);
    const email = clean(req.body.email, 200)?.toLowerCase();
    const phone = clean(req.body.phone, 40);
    const reference = clean(req.body.reference, 60);
    const message = clean(req.body.message, 2000);

    if (!name || !email || !message) {
      return res.status(400).json({
        message: "Name, email and a message are required.",
      });
    }
    if (!isEmail(email)) {
      return res
        .status(400)
        .json({ message: "That email doesn't look right." });
    }
    if (message.length < 10) {
      return res.status(400).json({
        message: "Please tell us a bit more so we can help.",
      });
    }

    // Five messages an hour is plenty for a real person
    const recent = await ContactMessage.countDocuments({
      email,
      createdAt: { $gt: new Date(Date.now() - 3_600_000) },
    });
    if (recent >= 5) {
      return res.status(429).json({
        message:
          "You've sent several messages recently. We'll reply to those first.",
      });
    }

    const doc = await ContactMessage.create({
      topic,
      topicLabel,
      name,
      email,
      phone,
      reference,
      message,
      user: req.user?.userId,
      ip: req.clientIp ?? req.ip,
    });

    const ticket = shortRef(doc._id);

    res.status(201).json({ message: "Message received", reference: ticket });

    // Non-blocking — a slow SMTP pool must not hold the response
    sendContactEmails({
      reference: ticket,
      topic,
      topicLabel,
      name,
      email,
      phone,
      orderReference: reference,
      message,
    }).catch((e) => console.error("[contact] email:", e.message));
  } catch (err) {
    console.error("[submitContact]", err);
    res.status(500).json({
      message: "We couldn't send that. Please email support@smilebabahub.com.",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /support/deletion-request
//
// Replies identically whether or not an account exists — otherwise this
// becomes a way to check which email addresses have SmileBaba accounts.
// ═══════════════════════════════════════════════════════════════════════
export const requestAccountDeletion = async (req, res) => {
  try {
    const email = clean(req.body.email, 200)?.toLowerCase();
    const phone = clean(req.body.phone, 40);
    const reason = clean(req.body.reason, 120);
    const notes = clean(req.body.notes, 500);

    if (!email || !isEmail(email)) {
      return res
        .status(400)
        .json({ message: "A valid email address is required." });
    }

    const genericOk = () =>
      res.status(200).json({
        message:
          "If an account exists for that address, we've sent a confirmation email.",
      });

    const user = await User.findOne({ email })
      .select("_id username email")
      .lean();

    // No account — log it so support can help if they used a different
    // address, then reply exactly as if there had been one.
    if (!user) {
      await DeletionRequest.create({
        email,
        phone,
        reason,
        notes,
        status: "rejected",
        cancelReason: "No account found for that email",
        ip: req.clientIp ?? req.ip,
      });
      return genericOk();
    }

    // Don't stack requests
    const existing = await DeletionRequest.findOne({
      user: user._id,
      status: { $in: ["pending_confirmation", "confirmed"] },
    }).lean();
    if (existing) return genericOk();

    // Raw token goes in the email, hash goes in the database — same
    // reasoning as a password.
    const raw = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(raw).digest("hex");

    const request = await DeletionRequest.create({
      email,
      phone,
      user: user._id,
      reason,
      notes,
      tokenHash,
      tokenExpiresAt: new Date(Date.now() + 48 * 3_600_000),
      status: "pending_confirmation",
      ip: req.clientIp ?? req.ip,
    });

    genericOk();

    sendDeletionConfirmEmail({
      username: user.username,
      email,
      confirmUrl: `${SITE}/account/delete/confirm?token=${raw}&id=${request._id}`,
      graceDays: GRACE_DAYS,
    }).catch((e) => console.error("[deletion] confirm email:", e.message));
  } catch (err) {
    console.error("[requestAccountDeletion]", err);
    res.status(500).json({
      message:
        "We couldn't submit that. Please email privacy@smilebabahub.com.",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /support/deletion-request/confirm?token=…&id=…
// ═══════════════════════════════════════════════════════════════════════
export const confirmAccountDeletion = async (req, res) => {
  try {
    const { token, id } = req.query;
    if (!token || !id) {
      return res.status(400).json({ message: "This link isn't valid." });
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(String(token))
      .digest("hex");

    const request = await DeletionRequest.findOne({
      _id: id,
      tokenHash,
      status: "pending_confirmation",
      tokenExpiresAt: { $gt: new Date() },
    });

    if (!request) {
      return res.status(400).json({
        message: "This link has expired or has already been used.",
        code: "INVALID_TOKEN",
      });
    }

    const scheduledFor = new Date(Date.now() + GRACE_DAYS * 86_400_000);

    request.status = "confirmed";
    request.confirmedAt = new Date();
    request.scheduledFor = scheduledFor;
    request.tokenHash = undefined; // single use
    await request.save();

    // Flag the account so the app can show a banner explaining that
    // signing in cancels it
    await User.updateOne(
      { _id: request.user },
      {
        $set: {
          deletionRequestedAt: new Date(),
          deletionScheduledFor: scheduledFor,
        },
      },
    ).catch(() => {});

    res.status(200).json({
      message: "Deletion confirmed",
      scheduledFor,
      graceDays: GRACE_DAYS,
    });

    const user = await User.findById(request.user).select("username").lean();
    sendDeletionScheduledEmail({
      username: user?.username,
      email: request.email,
      scheduledFor,
    }).catch((e) => console.error("[deletion] scheduled email:", e.message));
  } catch (err) {
    console.error("[confirmAccountDeletion]", err);
    res.status(500).json({ message: "Something went wrong." });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// Cancel on sign-in.
//
// Call from the login handler after authentication succeeds. The emails
// promise this happens, so it has to.
// ═══════════════════════════════════════════════════════════════════════
export async function cancelDeletionOnLogin(userId) {
  try {
    const result = await DeletionRequest.updateMany(
      {
        user: userId,
        status: { $in: ["pending_confirmation", "confirmed"] },
      },
      {
        $set: {
          status: "cancelled",
          cancelledAt: new Date(),
          cancelReason: "User signed in",
        },
      },
    );

    if (result.modifiedCount > 0) {
      await User.updateOne(
        { _id: userId },
        { $unset: { deletionRequestedAt: "", deletionScheduledFor: "" } },
      );
      console.log(`[deletion] cancelled for ${userId} — user signed in`);
    }
  } catch (err) {
    console.error("[cancelDeletionOnLogin]", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// The worker that actually deletes. Run daily.
//
// What it doesn't do matters as much as what it does: orders and
// transfers are anonymised rather than removed, because tax and AML law
// requires the record even when the person is gone — and the vendor on
// the other side of a transaction has their own right to it.
// ═══════════════════════════════════════════════════════════════════════
export async function processDueDeletions() {
  const due = await DeletionRequest.find({
    status: "confirmed",
    scheduledFor: { $lte: new Date() },
  }).limit(50);

  let completed = 0;

  for (const request of due) {
    try {
      const userId = request.user;
      const retained = [];

      const orderCount = await Order.countDocuments({
        $or: [{ buyer: userId }, { vendor: userId }],
      });
      if (orderCount > 0) {
        retained.push(
          `${orderCount} order record${orderCount === 1 ? "" : "s"} kept for tax and accounting law`,
        );
      }

      // Anonymise rather than drop the row, so retained records don't
      // end up with dangling references
      await User.updateOne(
        { _id: userId },
        {
          $set: {
            username: `deleted-user-${shortRef(userId).toLowerCase()}`,
            email: `deleted-${userId}@deleted.smilebabahub.com`,
            phone: null,
            whatsapp: null,
            profilePicture: null,
            storeName: null,
            storeSlug: null,
            storeBio: null,
            storeBanner: null,
            momoDetails: null,
            bankDetails: null,
            pushTokens: [],
            pushEnabled: false,
            isDeleted: true,
            deletedAt: new Date(),
          },
          $unset: {
            password: "",
            deletionRequestedAt: "",
            deletionScheduledFor: "",
          },
        },
      );

      request.status = "completed";
      request.completedAt = new Date();
      request.retentionNotes = retained;
      await request.save();

      sendDeletionCompleteEmail({
        email: request.email,
        retentionNotes: retained,
      }).catch(() => {});

      completed += 1;
      console.log(`[deletion] completed for ${userId}`);
    } catch (err) {
      console.error(`[deletion] failed for ${request._id}:`, err.message);
    }
  }

  if (due.length > 0) {
    console.log(`[deletion] processed ${completed}/${due.length} due requests`);
  }
  return completed;
}
