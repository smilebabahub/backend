// lib/notify.js
//
// One call that reaches a user everywhere they might be looking:
//   · Notification document  — the in-app bell, survives a reinstall
//   · Socket push            — live badge update if they're on screen
//   · Expo push              — reaches them when the app is closed
//
// Replaces the scattered `Notification.create(...) + pushToUser(...)` pairs.
// Each channel fails independently — a dead push token must never stop the
// database row from being written.
//
// SETUP
//   npm install expo-server-sdk
//
//   models/user.js — add:
//     pushTokens: [{
//       token:      { type: String, required: true },
//       platform:   { type: String, enum: ["ios", "android"] },
//       deviceId:   String,
//       lastUsedAt: { type: Date, default: Date.now },
//     }],
//     pushEnabled: { type: Boolean, default: true },

import { Expo } from "expo-server-sdk";
import Notification from "../models/notificationModel.js";
import User from "../models/user.js";
import { pushToUser } from "./socketHandler.js";

const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN, // optional, raises rate limits
});

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC
// ═══════════════════════════════════════════════════════════════════════

/**
 * Notify a user across every channel.
 *
 * @param {object}  opts
 * @param {string}  opts.userId
 * @param {string}  opts.type          Notification model enum value
 * @param {string}  opts.title
 * @param {string}  opts.message
 * @param {string} [opts.actionUrl]    Deep link path, e.g. "/orders/abc123"
 * @param {string} [opts.actionLabel]
 * @param {string} [opts.dedupeKey]    Prevents duplicate rows on retries
 * @param {object} [opts.data]         Extra payload for the push handler
 * @param {boolean}[opts.push=true]    Set false for low-value notifications
 */
export async function notify({
  userId,
  type,
  title,
  message,
  actionUrl,
  actionLabel,
  dedupeKey,
  data = {},
  push = true,
}) {
  if (!userId) return;

  // ── 1. Database row ───────────────────────────────────────────────
  try {
    if (dedupeKey) {
      await Notification.findOneAndUpdate(
        { dedupeKey },
        {
          user: userId,
          type,
          title,
          message,
          actionUrl,
          actionLabel,
          dedupeKey,
        },
        { upsert: true, setDefaultsOnInsert: true },
      );
    } else {
      await Notification.create({
        user: userId,
        type,
        title,
        message,
        actionUrl,
        actionLabel,
      });
    }
  } catch (err) {
    console.error("[notify] db write failed:", err.message);
  }

  // ── 2. Live socket badge ──────────────────────────────────────────
  try {
    pushToUser(String(userId), "new_notification", { title, message });
  } catch {
    /* socket layer is best-effort */
  }

  // ── 3. Device push ────────────────────────────────────────────────
  if (push) {
    sendPush({
      userId,
      title,
      body: message,
      data: { ...data, url: actionUrl, type },
    }).catch((err) => console.error("[notify] push failed:", err.message));
  }
}

/**
 * Send an Expo push to every device a user has registered.
 * Invalid tokens are pruned automatically.
 */
export async function sendPush({ userId, title, body, data = {} }) {
  const user = await User.findById(userId)
    .select("pushTokens pushEnabled")
    .lean();

  if (!user?.pushEnabled) return;

  const tokens = (user.pushTokens ?? [])
    .map((t) => t.token)
    .filter((t) => Expo.isExpoPushToken(t));

  if (tokens.length === 0) return;

  const messages = tokens.map((to) => ({
    to,
    sound: "default",
    title,
    body,
    data,
    priority: "high",
    channelId: "default", // Android channel, created on the client
  }));

  const chunks = expo.chunkPushNotifications(messages);
  const bad = [];

  for (const chunk of chunks) {
    try {
      const receipts = await expo.sendPushNotificationsAsync(chunk);
      receipts.forEach((r, i) => {
        if (r.status === "error") {
          const code = r.details?.error;
          // The device uninstalled or reset — stop sending to it
          if (code === "DeviceNotRegistered") bad.push(chunk[i].to);
          else console.warn("[push]", code, r.message);
        }
      });
    } catch (err) {
      console.error("[push] chunk failed:", err.message);
    }
  }

  if (bad.length > 0) {
    await User.updateOne(
      { _id: userId },
      { $pull: { pushTokens: { token: { $in: bad } } } },
    ).catch(() => {});
  }
}

/** Notify several users with the same payload. */
export async function notifyMany(userIds, payload) {
  await Promise.allSettled(
    [...new Set(userIds.filter(Boolean).map(String))].map((userId) =>
      notify({ ...payload, userId }),
    ),
  );
}

