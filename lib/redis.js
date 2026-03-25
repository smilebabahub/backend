// lib/redis.js
// Redis client — used for:
//   1. Referral code cache (fast lookup without DB hit)
//   2. Session / token blacklist
//   3. Rate limiting
//   4. Pub/Sub for real-time updates pushed to frontend

import { createClient } from "redis";

const client = createClient({
  url: process.env.REDIS_URL ?? "redis://localhost:6379",
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error("Redis: too many reconnect attempts — giving up");
        return new Error("Redis max retries exceeded");
      }
      return Math.min(retries * 100, 3000); // back-off up to 3s
    },
  },
});

client.on("error", (err) => console.error("Redis error:", err));
client.on("connect", () => console.log("Redis connected"));
client.on("reconnecting", () => console.log("Redis reconnecting…"));

// Connect once on startup
let connected = false;
export async function connectRedis() {
  if (connected) return;
  await client.connect();
  connected = true;
}

export default client;

// ── Key schema (centralised so typos can't cause cache misses) ─────────────
export const KEYS = {
  referralCode: (code) => `referral:code:${code}`, // code → marketerId
  marketerStats: (id) => `marketer:stats:${id}`, // cached stats
  rateLimit: (ip) => `rate:${ip}`, // request counter
  tokenBlacklist: (jti) => `blacklist:token:${jti}`, // logged-out tokens
  appVersion: () => "app:version", // current deploy hash
  cacheVersion: (scope) => `cache:version:${scope}`, // bust by scope
};

// ── TTLs (seconds) ────────────────────────────────────────────────────────
export const TTL = {
  referralCode: 60 * 60 * 24, // 24 hours
  marketerStats: 60 * 5, // 5 minutes
  rateLimit: 60, // 1 minute window
  tokenBlacklist: 60 * 60 * 25, // slightly longer than JWT expiry (24h)
  appVersion: 0, // no expiry — set on deploy
};

// ── Helpers ────────────────────────────────────────────────────────────────

/** Cache a referral code → marketer mapping */
export async function cacheReferralCode(code, marketerId) {
  await client.setEx(
    KEYS.referralCode(code),
    TTL.referralCode,
    String(marketerId),
  );
}

/** Look up a referral code — returns marketerId string or null */
export async function getReferralCode(code) {
  return client.get(KEYS.referralCode(code.toUpperCase()));
}

/** Invalidate a referral code (e.g. marketer deactivated) */
export async function invalidateReferralCode(code) {
  await client.del(KEYS.referralCode(code));
}

/** Blacklist a JWT (on logout) */
export async function blacklistToken(jti, expiresInSeconds) {
  await client.setEx(KEYS.tokenBlacklist(jti), expiresInSeconds, "1");
}

/** Check if token is blacklisted */
export async function isTokenBlacklisted(jti) {
  return (await client.get(KEYS.tokenBlacklist(jti))) === "1";
}

// ── Pub/Sub channel names ──────────────────────────────────────────────────
export const CHANNELS = {
  appUpdate: "channel:app:update", // new deploy → bust client cache
  statsUpdate: "channel:stats:update", // marketer stats changed
};

/**
 * Publish a message to a Redis channel.
 * Receivers (SSE clients) will push it to connected browsers.
 */
export async function publish(channel, data) {
  // Need a separate client for pub — the main client can be in subscriber mode
  await client.publish(channel, JSON.stringify(data));
}
