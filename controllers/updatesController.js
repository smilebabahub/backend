// controllers/updatesController.js
// Server-Sent Events — pushes real-time updates to connected browsers.
// Used for:
//   1. App version changes (new deploy → client reloads automatically)
//   2. Marketer stats updates (commission credited → dashboard refreshes)

import { CHANNELS, publish, createSubscriberClient } from "../lib/redis.js";

// ── SSE origin helper ─────────────────────────────────────────────────────
// The global cors() middleware may not apply headers before flushHeaders(),
// so every SSE handler sets them explicitly.
function setSseHeaders(req, res) {
  const origin = req.headers.origin;
  // Mirror the same allow-list used by the global CORS middleware
  const allowed = [
    "http://localhost:3000",
    "http://localhost:3001",
    "https://smilebabahub.com",
    "https://www.smilebabahub.com",
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.FRONTEND_URL,
  ].filter(Boolean);

  const isAllowed =
    !origin ||
    allowed.includes(origin) ||
    /^https:\/\/smilebabahub.*\.vercel\.app$/.test(origin);

  if (isAllowed && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable Nginx buffering
}

// ── App version SSE (/updates/app) ─────────────────────────────────────────
// Browser connects once and stays connected.
// When we deploy, call POST /updates/deploy — all connected browsers reload.
export const appUpdatesSSE = async (req, res) => {
  setSseHeaders(req, res);
  res.flushHeaders();

  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25_000);

  const sub = await createSubscriberClient();

  // If Redis unavailable, keep SSE open with just heartbeats
  if (!sub) {
    req.on("close", () => clearInterval(heartbeat));
    return;
  }

  await sub.subscribe(CHANNELS.appUpdate, (message) => {
    res.write(`event: app-update\ndata: ${message}\n\n`);
  });

  req.on("close", async () => {
    clearInterval(heartbeat);
    await sub.unsubscribe(CHANNELS.appUpdate).catch(() => null);
    await sub.disconnect().catch(() => null);
  });
};

// ── Marketer stats SSE (/updates/marketer/:id) ─────────────────────────────
// Marketer dashboard connects and receives live commission updates.
export const marketerStatsSSE = async (req, res) => {
  const { marketerId } = req.marketer;

  setSseHeaders(req, res);
  res.flushHeaders();

  const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 25_000);

  const sub = await createSubscriberClient();

  if (!sub) {
    req.on("close", () => clearInterval(heartbeat));
    return;
  }

  await sub.subscribe(CHANNELS.statsUpdate, (message) => {
    const data = JSON.parse(message);
    if (String(data.marketerId) === String(marketerId)) {
      res.write(`event: stats-update\ndata: ${message}\n\n`);
    }
  });

  req.on("close", async () => {
    clearInterval(heartbeat);
    await sub.unsubscribe(CHANNELS.statsUpdate).catch(() => null);
    await sub.disconnect().catch(() => null);
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
