// lib/chatNotifier.js
//
// Sends an email to a chat recipient when they're offline AND have unread messages.
// Debounced per-user: at most one email every 10 minutes per receiver, no matter
// how many messages arrive in that window. This prevents spam if the sender
// types 30 short messages in a row.
//
// Strategy:
//   - On every new message: check if receiver is offline (no socket online_users entry)
//   - If offline, schedule a "you have unread messages" email with a 60-second delay
//   - If they reconnect within those 60 seconds, the email is cancelled
//   - Once an email is sent, suppress further emails to the same receiver for 10 minutes
//
// Storage: in-memory Map for the debounce timer (per-process — fine for single-instance
// deployments like Render). For multi-instance, swap to Redis keys with TTL.

import User from "../models/user.js";
import { logError } from "./errorLog.js";
import { safeRedis } from "./redis.js";

// In-memory debounce timer map: receiverId → setTimeout handle
const pendingTimers = new Map();

// Suppress duplicate emails for 10 minutes per receiver
const SUPPRESS_MIN = 10;
const NOTIFY_DELAY = 60_000; // 60 seconds — gives recipient a chance to come online

/**
 * Called from socketHandler.js after a message is saved.
 * @param {Object}  params
 * @param {String}  params.receiverId   The user who should receive the email
 * @param {String}  params.senderId     Who sent the message
 * @param {Boolean} params.isReceiverOnline  Is receiver currently connected via socket?
 */
export function maybeNotifyByEmail({ receiverId, senderId, isReceiverOnline }) {
  // If receiver is online, the socket emit handles their notification — no email needed.
  if (isReceiverOnline) {
    // Cancel any pending email — they got the message live
    const pending = pendingTimers.get(String(receiverId));
    if (pending) {
      clearTimeout(pending);
      pendingTimers.delete(String(receiverId));
    }
    return;
  }

  // Already scheduled? Don't schedule again
  if (pendingTimers.has(String(receiverId))) return;

  const handle = setTimeout(async () => {
    pendingTimers.delete(String(receiverId));
    try {
      await sendChatNotificationEmail({ receiverId, senderId });
    } catch (err) {
      logError("chatNotifier.sendChatNotificationEmail", err);
    }
  }, NOTIFY_DELAY);

  pendingTimers.set(String(receiverId), handle);
}

/**
 * Cancel a pending email — called when receiver reconnects to socket.
 */
export function cancelPendingNotification(receiverId) {
  const pending = pendingTimers.get(String(receiverId));
  if (pending) {
    clearTimeout(pending);
    pendingTimers.delete(String(receiverId));
  }
}

// ── Send the email (with redis-backed suppression) ─────────────────────────
async function sendChatNotificationEmail({ receiverId, senderId }) {
  // Suppression: redis key with 10-minute TTL
  const suppressKey = `chat:notif:${receiverId}`;
  const isSuppressed = await safeRedis(async (c) => c.get(suppressKey));
  if (isSuppressed) return;

  // Load receiver + sender + unread count
  const Message = (await import("../models/chatModel.js")).default;
  const [receiver, sender, unreadCount] = await Promise.all([
    User.findById(receiverId)
      .select("username email notifications country")
      .lean(),
    User.findById(senderId).select("username").lean(),
    Message.countDocuments({
      receiver: receiverId,
      readBy: { $ne: String(receiverId) },
      deleted: false,
      deletedFor: { $ne: String(receiverId) },
    }),
  ]);

  if (!receiver?.email) return;
  if (unreadCount === 0) return; // Already read on another device

  // Respect user's notification preference if they've opted out
  // (notifications.chatEmail defaults to true — only skip if explicitly false)
  if (receiver.notifications?.chatEmail === false) return;

  // Send the email
  const senderName = sender?.username ?? "Someone";
  const frontend = (
    process.env.APP_URL ??
    process.env.FRONTEND_URL ??
    "https://smilebabahub.com"
  ).replace(/\/+$/, "");
  const chatUrl = `${frontend}/chat`;

  const subject =
    unreadCount === 1
      ? `${senderName} sent you a message on SmileBaba`
      : `You have ${unreadCount} unread messages on SmileBaba`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;
      padding:32px 24px;color:#111;">
      <div style="text-align:center;margin-bottom:24px;">
        <div style="display:inline-block;width:48px;height:48px;background:#FFC105;
          border-radius:16px;line-height:48px;text-align:center;font-size:24px;">
          💬
        </div>
        <h2 style="font-size:18px;font-weight:900;margin:12px 0 4px;">
          ${
            unreadCount === 1
              ? `New message from ${senderName}`
              : `${unreadCount} unread messages`
          }
        </h2>
        <p style="font-size:13px;color:#6B7280;margin:0;">
          Hi ${receiver.username ?? "there"}, you have unread messages waiting.
        </p>
      </div>

      <div style="background:#FFFBEB;border:1px solid #FEF3C7;border-radius:12px;
        padding:16px;margin-bottom:20px;text-align:center;">
        <p style="font-size:13px;color:#92400E;margin:0;">
          💡 Reply quickly — buyers and sellers are 3× more likely to close a deal
          when they get a fast response.
        </p>
      </div>

      <p style="text-align:center;margin:0 0 24px;">
        <a href="${chatUrl}"
          style="display:inline-block;background:#FFC105;color:#111;
          padding:14px 32px;border-radius:12px;text-decoration:none;
          font-weight:800;font-size:14px;">
          Read messages
        </a>
      </p>

      <p style="font-size:11px;color:#9CA3AF;line-height:1.6;margin:0;
        border-top:1px solid #E5E7EB;padding-top:16px;text-align:center;">
        You're receiving this because you have new messages on SmileBabaHub.
        <br>
        <a href="${frontend}/account/notifications"
          style="color:#9CA3AF;">Manage notifications</a>
      </p>
    </div>
  `;

  try {
    const { sendDirectEmail } = await import("./emailService.js");
    await sendDirectEmail({
      to: receiver.email,
      subject,
      html,
    });

    // Mark suppressed for 10 minutes so a burst of replies doesn't trigger more emails
    await safeRedis(async (c) => c.setEx(suppressKey, SUPPRESS_MIN * 60, "1"));
  } catch (err) {
    logError("chatNotifier.sendDirectEmail", err);
  }
}
