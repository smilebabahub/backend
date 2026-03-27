// lib/redis.js
// Redis client — used for:
//   1. Referral code cache (fast lookup without DB hit)
//   2. Session / token blacklist
//   3. Pub/Sub for real-time updates pushed to frontend
//
// GRACEFUL DEGRADATION: if Redis is unavailable (e.g. local dev without Redis
// installed), all cache helpers silently no-op and the app falls back to DB
// for referral lookups. The server never crashes due to Redis being down.

import { createClient } from "redis";

// ── Connection state ───────────────────────────────────────────────────────
let client = null;
let connected = false;
let available = false; // true only once first connect succeeds

// ── Create client ─────────────────────────────────────────────────────────
function createRedisClient() {
  const c = createClient({
    url: process.env.REDIS_URL ?? "redis://localhost:6379",
    socket: {
      // In dev, stop retrying quickly so the server starts fast
      reconnectStrategy: (retries) => {
        const maxRetries = process.env.NODE_ENV === "production" ? 20 : 3;
        if (retries >= maxRetries) {
          console.warn(
            `Redis: gave up after ${retries} retries. ` +
              `Running without cache — app still works via DB fallback.`,
          );
          available = false;
          return false; // stop retrying
        }
        const delay = Math.min(retries * 200, 2000);
        console.log(
          `Redis: reconnecting in ${delay}ms (attempt ${retries + 1})…`,
        );
        return delay;
      },
      connectTimeout: 5000, // 5s — don't hang startup
    },
  });

  c.on("connect", () => {
    connected = true;
    available = true;
    console.log("Redis connected");
  });
  c.on("ready", () => {
    available = true;
  });
  c.on("end", () => {
    connected = false;
    available = false;
  });
  c.on("reconnecting", () => console.log("Redis reconnecting…"));
  c.on("error", (err) => {
    // Only log the first error to avoid flooding the console
    if (available) {
      console.warn("Redis error — switching to DB fallback:", err.message);
    }
    available = false;
  });

  return c;
}

// ── Connect once on startup ────────────────────────────────────────────────
export async function connectRedis() {
  if (connected) return;
  try {
    client = createRedisClient();
    await client.connect();
    connected = true;
    available = true;
  } catch (err) {
    console.warn(
      "⚠️  Redis unavailable — running without cache.\n" +
        "   To enable: install Redis locally (brew install redis && redis-server)\n" +
        "   or set REDIS_URL to an Upstash/Redis Cloud URL in your .env\n" +
        `   Error: ${err.message}`,
    );
    available = false;
  }
}

// ── Safe wrapper — silently no-ops if Redis is down ────────────────────────
async function safeRedis(fn, fallback = null) {
  if (!available || !client) return fallback;
  try {
    return await fn(client);
  } catch (err) {
    console.warn("Redis op failed (non-fatal):", err.message);
    available = false;
    return fallback;
  }
}

export default {
  get isAvailable() {
    return available;
  },
};

// ── Key schema ─────────────────────────────────────────────────────────────
export const KEYS = {
  referralCode: (code) => `referral:code:${code}`,
  marketerStats: (id) => `marketer:stats:${id}`,
  rateLimit: (ip) => `rate:${ip}`,
  tokenBlacklist: (jti) => `blacklist:token:${jti}`,
  appVersion: () => "app:version",
};

export const TTL = {
  referralCode: 60 * 60 * 24, // 24h
  marketerStats: 60 * 5, // 5min
  rateLimit: 60, // 1min
  tokenBlacklist: 60 * 60 * 25, // 25h (longer than JWT expiry)
};

// ── Cache helpers (all safe — silently skip if Redis down) ─────────────────

export async function cacheReferralCode(code, marketerId) {
  await safeRedis((c) =>
    c.setEx(
      KEYS.referralCode(code.toUpperCase()),
      TTL.referralCode,
      String(marketerId),
    ),
  );
}

export async function getReferralCode(code) {
  return safeRedis((c) => c.get(KEYS.referralCode(code.toUpperCase())));
}

export async function invalidateReferralCode(code) {
  await safeRedis((c) => c.del(KEYS.referralCode(code.toUpperCase())));
}

export async function blacklistToken(jti, expiresInSeconds) {
  await safeRedis((c) =>
    c.setEx(KEYS.tokenBlacklist(jti), expiresInSeconds, "1"),
  );
}

export async function isTokenBlacklisted(jti) {
  const val = await safeRedis((c) => c.get(KEYS.tokenBlacklist(jti)));
  return val === "1";
}

// ── Pub/Sub ────────────────────────────────────────────────────────────────
export const CHANNELS = {
  appUpdate: "channel:app:update",
  statsUpdate: "channel:stats:update",
};

export async function publish(channel, data) {
  await safeRedis((c) => c.publish(channel, JSON.stringify(data)));
}

// ── Subscriber factory (for SSE endpoints) ────────────────────────────────
// Each SSE connection needs its own subscriber client instance.
// Returns null if Redis is unavailable — callers must handle this.
export async function createSubscriberClient() {
  if (!available) return null;
  try {
    const sub = createClient({
      url: process.env.REDIS_URL ?? "redis://localhost:6379",
    });
    await sub.connect();
    return sub;
  } catch (err) {
    console.warn("Redis subscriber unavailable:", err.message);
    return null;
  }
}
