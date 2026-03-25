// controllers/updatesController.js
// Server-Sent Events — pushes real-time updates to connected browsers.
// Used for:
//   1. App version changes (new deploy → client reloads automatically)
//   2. Marketer stats updates (commission credited → dashboard refreshes)

import { createClient } from "redis";
import { CHANNELS, publish } from "../lib/redis.js";

// Each SSE connection gets its own subscriber client
// (Redis subscriber clients can't do other operations)
async function createSubscriberClient() {
  const sub = createClient({
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
  });
  await sub.connect();
  return sub;
}

// ── App version SSE (/updates/app) ─────────────────────────────────────────
// Browser connects once and stays connected.
// When we deploy, we call POST /updates/deploy which publishes to Redis.
// All connected browsers receive the event and reload.
export const appUpdatesSSE = async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable Nginx buffering
  res.flushHeaders();

  // Send a heartbeat every 25s to keep the connection alive through proxies
  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 25_000);

  // Subscribe to app update channel
  const sub = await createSubscriberClient();

  await sub.subscribe(CHANNELS.appUpdate, (message) => {
    res.write(`event: app-update\ndata: ${message}\n\n`);
  });

  req.on("close", async () => {
    clearInterval(heartbeat);
    await sub.unsubscribe(CHANNELS.appUpdate);
    await sub.disconnect();
  });
};

// ── Marketer stats SSE (/updates/marketer/:id) ─────────────────────────────
// Marketer dashboard connects and receives live commission updates.
export const marketerStatsSSE = async (req, res) => {
  const { marketerId } = req.marketer; // injected by authenticateMarketer middleware

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25_000);

  const sub = await createSubscriberClient();

  await sub.subscribe(CHANNELS.statsUpdate, (message) => {
    const data = JSON.parse(message);
    // Only forward if this update is for the connected marketer
    if (String(data.marketerId) === String(marketerId)) {
      res.write(`event: stats-update\ndata: ${message}\n\n`);
    }
  });

  req.on("close", async () => {
    clearInterval(heartbeat);
    await sub.unsubscribe(CHANNELS.statsUpdate);
    await sub.disconnect();
  });
};

// ── Deploy webhook (/updates/deploy) ──────────────────────────────────────
// Call this from your CI/CD pipeline after a successful deploy.
// All connected browsers will receive the event and reload.
//
// Example with curl:
//   curl -X POST https://api.smilebabahub.com/smilebaba/updates/deploy \
//        -H "x-deploy-secret: YOUR_DEPLOY_SECRET"
export const triggerDeploy = async (req, res) => {
  const secret = req.headers["x-deploy-secret"];
  if (secret !== process.env.DEPLOY_SECRET) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const version = req.body.version ?? `${Date.now()}`;

  await publish(
    CHANNELS.appUpdate,
    JSON.stringify({
      version,
      deployedAt: new Date().toISOString(),
      message: "New version available. Reloading…",
    }),
  );

  res.status(200).json({ message: "Deploy event published", version });
};
