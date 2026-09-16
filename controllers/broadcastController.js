// controllers/broadcastController.js
//
// Admin announcements: one message, every matching user, as an in-app
// notification and a push.
//
// ─── WHY THIS ISN'T A LOOP IN A REQUEST HANDLER ──────────────────────
//
// With ten thousand users, the obvious version:
//
//     for (const user of users) await Notification.create({ … });
//
// takes minutes, holds a connection open, times out on Render's 30s
// limit, and leaves half the users notified with no record of which
// half. Sending again then double-notifies everyone who already got it.
//
// So the request creates a Broadcast document and returns. A background
// pass works through it in batches, saving progress as it goes — which
// means a crash mid-send resumes rather than restarting, and the admin
// can watch it happen.
//
// ─── AND WHY EXPO IS CHUNKED ─────────────────────────────────────────
//
// Expo's push API accepts at most 100 messages per request and rate
// limits above roughly 600 a second. Firing ten thousand at once gets
// the whole batch dropped, silently, with a 200 response.
//
// Chunks of 100 with a small pause between them is slower and actually
// arrives.

import mongoose from "mongoose";
import User from "../models/user.js";
import Notification from "../models/notificationModel.js";
import { pushToUser } from "../lib/socketHandler.js";
import Broadcast from "../models/broadcastModel.js";

const EXPO_URL = "https://exp.host/--/api/v2/push/send";

/** Expo's own cap. Not a tuning choice. */
const PUSH_CHUNK = 100;

/** Users per database pass. Small enough to stay well inside memory. */
const USER_BATCH = 500;

/** Expo rate-limits above ~600/s. This keeps us comfortably under. */
const CHUNK_PAUSE_MS = 250;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const clean = (v, max = 500) =>
  typeof v === "string" ? v.trim().slice(0, max) : undefined;

// ═══════════════════════════════════════════════════════════════════════
// Who gets it
// ═══════════════════════════════════════════════════════════════════════
function buildAudienceQuery(audience = {}) {
  const q = {
    isActive: { $ne: false },
    isDeleted: { $ne: true },
  };

  // "vendors" means anyone who sells, which since onboarding went free
  // means a store name rather than a paid plan
  if (audience.segment === "vendors") {
    q.$or = [{ storeName: { $exists: true, $ne: "" } }, { role: "vendor" }];
  } else if (audience.segment === "buyers") {
    q.storeName = { $in: [null, ""] };
    q.role = { $ne: "vendor" };
  } else if (audience.segment === "subscribers") {
    q["subscription.plan"] = { $nin: [null, "Basic"] };
    q["subscription.expiresAt"] = { $gt: new Date() };
  }

  if (audience.country && ["Ghana", "Nigeria"].includes(audience.country)) {
    q.country = audience.country;
  }

  // Someone who turned notifications off should not be reached by a
  // marketing announcement. Service messages go through notify()
  // directly and bypass this.
  if (audience.respectPushPreference !== false) {
    q.pushEnabled = { $ne: false };
  }

  return q;
}

// ═══════════════════════════════════════════════════════════════════════
// POST /admin/broadcasts   — compose and queue
// ═══════════════════════════════════════════════════════════════════════
export const createBroadcast = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const title = clean(req.body.title, 80);
    const message = clean(req.body.message, 500);

    if (!title || title.length < 3) {
      return res
        .status(400)
        .json({ message: "Give the announcement a title." });
    }
    if (!message || message.length < 10) {
      return res
        .status(400)
        .json({ message: "Write a bit more in the message." });
    }

    const audience = {
      segment: clean(req.body.segment, 20) ?? "all",
      country: clean(req.body.country, 20),
      respectPushPreference: req.body.respectPushPreference !== false,
    };

    const query = buildAudienceQuery(audience);
    const total = await User.countDocuments(query);

    if (total === 0) {
      return res.status(400).json({
        message: "Nobody matches that audience. Widen it and try again.",
        code: "EMPTY_AUDIENCE",
      });
    }

    const broadcast = await Broadcast.create({
      title,
      message,
      actionUrl: clean(req.body.actionUrl, 200),
      actionLabel: clean(req.body.actionLabel, 40),
      audience,
      sendPush: req.body.sendPush !== false,
      total,
      createdBy: req.user.userId,
      status: "sending",
    });

    // Back to the admin straight away. The work happens behind them.
    res.status(201).json({
      message: `Sending to ${total.toLocaleString()} ${total === 1 ? "person" : "people"}.`,
      broadcast: broadcast.toObject(),
    });

    processBroadcast(broadcast._id).catch((err) =>
      console.error("[broadcast] process:", err.message),
    );
  } catch (err) {
    console.error("[createBroadcast]", err);
    res.status(500).json({ message: "Couldn't start that announcement" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /admin/broadcasts/preview   — how many, before sending
// ═══════════════════════════════════════════════════════════════════════
export const previewAudience = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const audience = {
      segment: req.query.segment ?? "all",
      country: req.query.country,
      respectPushPreference: req.query.respectPushPreference !== "false",
    };

    const query = buildAudienceQuery(audience);

    const [total, withPush] = await Promise.all([
      User.countDocuments(query),
      User.countDocuments({ ...query, "pushTokens.0": { $exists: true } }),
    ]);

    res.status(200).json({
      total,
      // Everyone gets the in-app notification; only these get a push.
      // Worth showing, because an admin expecting 10,000 phones to buzz
      // should know it's 3,000.
      withPush,
      withoutPush: total - withPush,
    });
  } catch (err) {
    console.error("[previewAudience]", err);
    res.status(500).json({ message: "Couldn't count that audience" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// The worker
// ═══════════════════════════════════════════════════════════════════════
async function processBroadcast(broadcastId) {
  const broadcast = await Broadcast.findById(broadcastId);
  if (!broadcast || broadcast.status === "completed") return;

  const query = buildAudienceQuery(broadcast.audience);

  // Resumes from wherever it stopped. A crash halfway through doesn't
  // mean starting again, and nobody gets it twice.
  if (broadcast.lastUserId) {
    query._id = { $gt: new mongoose.Types.ObjectId(broadcast.lastUserId) };
  }

  let delivered = broadcast.delivered ?? 0;
  let pushed = broadcast.pushed ?? 0;
  let failed = broadcast.failed ?? 0;

  try {
    for (;;) {
      const users = await User.find(query)
        .select("_id pushTokens")
        .sort({ _id: 1 })
        .limit(USER_BATCH)
        .lean();

      if (users.length === 0) break;

      // ── In-app notifications ─────────────────────────────────────
      // insertMany with ordered:false so one bad document doesn't stop
      // the batch, and a dedupeKey per user so a re-run can't duplicate
      const docs = users.map((u) => ({
        user: u._id,
        type: "announcement",
        title: broadcast.title,
        message: broadcast.message,
        actionUrl: broadcast.actionUrl ?? "/",
        actionLabel: broadcast.actionLabel ?? "Open",
        dedupeKey: `broadcast-${broadcast._id}-${u._id}`,
      }));

      try {
        await Notification.insertMany(docs, { ordered: false });
      } catch (err) {
        // Duplicate key errors are the dedupe working, not a failure
        if (err.code !== 11000) throw err;
      }

      delivered += users.length;

      // Live badge for anyone currently connected
      users.forEach((u) => pushToUser(u._id, "new_notification", {}));

      // ── Push ──────────────────────────────────────────────────────
      if (broadcast.sendPush) {
        const messages = [];

        for (const u of users) {
          for (const t of u.pushTokens ?? []) {
            if (!t?.token) continue;
            messages.push({
              to: t.token,
              sound: "default",
              title: broadcast.title,
              body: broadcast.message,
              data: {
                type: "announcement",
                url: broadcast.actionUrl ?? "/",
                broadcastId: String(broadcast._id),
              },
              // Groups them in the tray rather than stacking
              channelId: "announcements",
            });
          }
        }

        const result = await sendExpoPush(messages);
        pushed += result.sent;
        failed += result.failed;

        if (result.deadTokens.length > 0) {
          await pruneDeadTokens(result.deadTokens);
        }
      }

      // ── Progress ─────────────────────────────────────────────────
      const lastId = users[users.length - 1]._id;
      query._id = { $gt: lastId };

      await Broadcast.updateOne(
        { _id: broadcast._id },
        { $set: { delivered, pushed, failed, lastUserId: lastId } },
      );

      if (users.length < USER_BATCH) break;
    }

    await Broadcast.updateOne(
      { _id: broadcast._id },
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
          delivered,
          pushed,
          failed,
        },
      },
    );

    console.log(
      `[broadcast] ${broadcast._id} done — ${delivered} notified, ${pushed} pushed, ${failed} failed`,
    );
  } catch (err) {
    console.error("[broadcast] failed:", err.message);
    await Broadcast.updateOne(
      { _id: broadcast._id },
      {
        $set: {
          status: "failed",
          error: err.message,
          delivered,
          pushed,
          failed,
        },
      },
    );
  }
}

/**
 * Expo caps a request at 100 messages and rate-limits above roughly
 * 600 a second. Sending ten thousand in one go returns 200 and delivers
 * nothing, which is the worst possible failure mode.
 */
async function sendExpoPush(messages) {
  let sent = 0;
  let failed = 0;
  const deadTokens = [];

  for (let i = 0; i < messages.length; i += PUSH_CHUNK) {
    const chunk = messages.slice(i, i + PUSH_CHUNK);

    try {
      const res = await fetch(EXPO_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(process.env.EXPO_ACCESS_TOKEN && {
            Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}`,
          }),
        },
        body: JSON.stringify(chunk),
      });

      const body = await res.json().catch(() => ({}));
      const tickets = body?.data ?? [];

      tickets.forEach((ticket, idx) => {
        if (ticket?.status === "ok") {
          sent += 1;
          return;
        }

        failed += 1;

        // The app was uninstalled, or the token was rotated. Keeping it
        // means failing on every future send, forever.
        if (ticket?.details?.error === "DeviceNotRegistered") {
          deadTokens.push(chunk[idx].to);
        }
      });
    } catch (err) {
      failed += chunk.length;
      console.warn("[broadcast] push chunk failed:", err.message);
    }

    if (i + PUSH_CHUNK < messages.length) await wait(CHUNK_PAUSE_MS);
  }

  return { sent, failed, deadTokens };
}

/** A token Expo has told us is dead never works again. */
async function pruneDeadTokens(tokens) {
  try {
    await User.updateMany(
      { "pushTokens.token": { $in: tokens } },
      { $pull: { pushTokens: { token: { $in: tokens } } } },
    );
    console.log(`[broadcast] pruned ${tokens.length} dead push tokens`);
  } catch (err) {
    console.warn("[broadcast] prune failed:", err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// GET /admin/broadcasts   — history and live progress
// ═══════════════════════════════════════════════════════════════════════
export const getBroadcasts = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const { page = 1, limit = 20 } = req.query;

    const [total, items] = await Promise.all([
      Broadcast.countDocuments(),
      Broadcast.find()
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("createdBy", "username email")
        .lean(),
    ]);

    res.status(200).json({
      broadcasts: items,
      meta: { total, page: Number(page), limit: Number(limit) },
    });
  } catch (err) {
    console.error("[getBroadcasts]", err);
    res.status(500).json({ message: "Couldn't load announcements" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /admin/broadcasts/:id/resume   — pick up a failed send
// ═══════════════════════════════════════════════════════════════════════
export const resumeBroadcast = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const broadcast = await Broadcast.findById(req.params.id);
    if (!broadcast) return res.status(404).json({ message: "Not found" });

    if (broadcast.status === "completed") {
      return res.status(409).json({ message: "That one already finished." });
    }

    await Broadcast.updateOne(
      { _id: broadcast._id },
      { $set: { status: "sending", error: null } },
    );

    res.status(200).json({ message: "Resuming from where it stopped." });

    // lastUserId means it continues rather than starting over, so
    // nobody gets it twice
    processBroadcast(broadcast._id).catch((err) =>
      console.error("[broadcast] resume:", err.message),
    );
  } catch (err) {
    console.error("[resumeBroadcast]", err);
    res.status(500).json({ message: "Couldn't resume that announcement" });
  }
};


// ═══════════════════════════════════════════════════════════════════════
// mobile — an Android channel for announcements
//
// Without this they land in the default channel alongside order updates,
// so someone who mutes announcements mutes their orders too.
//
// In usePushNotifications.ts, alongside the existing channel setup:
// ═══════════════════════════════════════════════════════════════════════
/*
 
*/

// ═══════════════════════════════════════════════════════════════════════
// ONE THING WORTH SETTING UP
//
// EXPO_ACCESS_TOKEN in your Render environment.
//
// Without it Expo accepts pushes but rate-limits harder and gives no
// receipts, so a silently dropped batch looks identical to a delivered
// one. Generate it at expo.dev → Account Settings → Access Tokens.
//
// It costs nothing and it's the difference between knowing a broadcast
// landed and hoping it did.
// ═══════════════════════════════════════════════════════════════════════
