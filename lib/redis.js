// lib/redis.js
// Redis client — used for:
//   1. Referral code cache (fast lookup without DB hit)
//   2. Session / token blacklist
//   3. Pub/Sub for real-time updates pushed to frontend
//   4. Feed caching per country + category
//
// GRACEFUL DEGRADATION: if Redis is unavailable, all helpers silently
// no-op and the app falls back to the database. The server never crashes
// because of Redis.
//
// ─── WHAT WAS CRASHING THE SERVER ────────────────────────────────────
//
//     Error: read ETIMEDOUT
//     Emitted 'error' event on Class instance at: RedisSocket…
//     [nodemon] app crashed
//
// The main client had an error listener, so it wasn't the culprit.
// createSubscriberClient did not:
//
//     const sub = createClient({ url: … });
//     await sub.connect();
//     return sub;              ← nothing listening for 'error'
//
// node-redis emits `error` as an EventEmitter event, and Node's rule is
// that an 'error' event with no listener becomes an unhandled exception.
// So every SSE connection created a client that would take the whole API
// down the moment its socket timed out — which Upstash does after a few
// minutes idle.
//
// ─── AND WHY IT NEVER CAME BACK ──────────────────────────────────────
//
// reconnectStrategy returned `false` after max retries, which tells
// node-redis to stop reconnecting permanently. So even a survived blip
// left the app running without a cache until someone restarted it.
//
// In production it now backs off to a slow retry instead, so a Redis
// outage heals itself.

import { createClient } from "redis";

// ── Connection state ───────────────────────────────────────────────────────
let client = null;
let connected = false;
let available = false; // true only once a connection succeeds

/** Every subscriber we hand out, so we can close them on shutdown. */
const subscribers = new Set();

/** Stops a flapping connection filling the logs with the same line. */
let lastErrorLoggedAt = 0;
const ERROR_LOG_GAP_MS = 30_000;

function logRedisError(scope, err) {
  const now = Date.now();
  if (now - lastErrorLoggedAt < ERROR_LOG_GAP_MS) return;
  lastErrorLoggedAt = now;
  console.warn(
    `Redis ${scope} error — falling back to DB: ${err?.message ?? err}`,
  );
}

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// ── Create client ─────────────────────────────────────────────────────────
function createRedisClient() {
  const c = createClient({
    url: REDIS_URL,
    socket: {
      /**
       * Dev gives up after three tries so a local server starts fast
       * without Redis installed.
       *
       * Production never gives up. Returning false here stops
       * reconnection permanently — which is why a single overnight
       * timeout left the app cacheless until a manual restart.
       */
      reconnectStrategy: (retries) => {
        available = false;

        if (process.env.NODE_ENV !== "production") {
          if (retries >= 3) {
            console.warn(
              "Redis: not available locally — running without cache. " +
                "Install with `brew install redis && redis-server`, or set " +
                "REDIS_URL to an Upstash URL.",
            );
            return false;
          }
          return Math.min(retries * 200, 2000);
        }

        // Production: back off, then keep trying every 30s forever
        if (retries > 20) return 30_000;
        return Math.min(retries * 200, 5_000);
      },

      connectTimeout: 10_000,

      // Upstash reaps idle connections. A keepalive is what stops a quiet
      // night turning into an ETIMEDOUT.
      keepAlive: 30_000,
    },
  });

  attachHandlers(c, "client");
  return c;
}

/**
 * Every client needs these, including duplicates and subscribers.
 * Forgetting them on one of them is what caused the crashes.
 */
function attachHandlers(c, scope) {
  c.on("error", (err) => {
    available = false;
    logRedisError(scope, err);
  });

  c.on("connect", () => {
    if (scope === "client") {
      connected = true;
      available = true;
      console.log("Redis connected");
    }
  });

  c.on("ready", () => {
    if (scope === "client") {
      available = true;
      lastErrorLoggedAt = 0;
    }
  });

  c.on("end", () => {
    if (scope === "client") {
      connected = false;
      available = false;
    }
  });

  c.on("reconnecting", () => {
    available = false;
  });

  return c;
}

// ── Connect once on startup ────────────────────────────────────────────────
export async function connectRedis() {
  if (connected && client?.isOpen) return;
  try {
    client ??= createRedisClient();
    if (!client.isOpen) await client.connect();
    connected = true;
    available = true;
  } catch (err) {
    console.warn(
      "Redis unavailable — running without cache.\n" +
        "   To enable: brew install redis && redis-server,\n" +
        "   or set REDIS_URL to an Upstash / Redis Cloud URL.\n" +
        `   Error: ${err.message}`,
    );
    available = false;
  }
}

// ── Safe wrapper — silently no-ops if Redis is down ────────────────────────
export async function safeRedis(fn, fallback = null) {
  if (!available || !client?.isOpen) return fallback;
  try {
    return await fn(client);
  } catch (err) {
    logRedisError("op", err);
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
  tokenBlacklist: 60 * 60 * 25, // 25h, longer than the JWT
};

// ── Cache helpers ──────────────────────────────────────────────────────────

export async function cacheReferralCode(code, marketerId) {
  await safeRedis((c) =>
    c.setEx(
      KEYS.referralCode(String(code).toUpperCase()),
      TTL.referralCode,
      String(marketerId),
    ),
  );
}

export async function getReferralCode(code) {
  return safeRedis((c) => c.get(KEYS.referralCode(String(code).toUpperCase())));
}

export async function invalidateReferralCode(code) {
  await safeRedis((c) => c.del(KEYS.referralCode(String(code).toUpperCase())));
}

export async function blacklistToken(jti, expiresInSeconds) {
  if (!jti || !(expiresInSeconds > 0)) return;
  await safeRedis((c) =>
    c.setEx(KEYS.tokenBlacklist(jti), Math.ceil(expiresInSeconds), "1"),
  );
}

export async function isTokenBlacklisted(jti) {
  // Returns false when Redis is down, meaning a logged-out token stays
  // valid until its own expiry. That's the right trade — the alternative
  // is rejecting every authenticated request during a cache outage.
  const val = await safeRedis((c) => c.get(KEYS.tokenBlacklist(jti)));
  return val === "1";
}

// ── Pub/Sub ────────────────────────────────────────────────────────────────
export const CHANNELS = {
  appUpdate: "channel:app:update",
  statsUpdate: "channel:stats:update",
};

export async function publish(channel, data) {
  await safeRedis((c) => c.publish(channel, JSON.stringify(data ?? {})));
}

// ── Subscriber factory (for SSE endpoints) ────────────────────────────────
//
// THIS IS THE ONE THAT WAS CRASHING THE SERVER.
//
// Each SSE connection gets its own client, because a client in
// subscriber mode can't run normal commands. Every one of those needs an
// error listener of its own — the main client's doesn't cover them.
//
// Returns null when Redis is unavailable. Callers already handle that.
export async function createSubscriberClient() {
  if (!available) return null;
  try {
    const sub = createClient({
      url: REDIS_URL,
      socket: {
        connectTimeout: 10_000,
        keepAlive: 30_000,
        // A subscriber that gives up is a dead SSE stream, so it retries
        // the same way the main client does
        reconnectStrategy: (retries) =>
          retries > 20 ? 30_000 : Math.min(retries * 200, 5_000),
      },
    });

    // The missing line. Without it, one timed-out SSE connection took
    // the whole API down.
    attachHandlers(sub, "subscriber");

    // Clean itself up so the set doesn't grow with every closed stream
    sub.on("end", () => subscribers.delete(sub));

    await sub.connect();
    subscribers.add(sub);
    return sub;
  } catch (err) {
    logRedisError("subscriber", err);
    return null;
  }
}

/**
 * Close a subscriber when its SSE connection ends.
 *
 * Worth calling from the `close` handler on every SSE route — an
 * abandoned subscriber holds a connection open, and Upstash's free tier
 * caps how many you get.
 */
export async function closeSubscriber(sub) {
  if (!sub) return;
  subscribers.delete(sub);
  try {
    if (sub.isOpen) await sub.quit();
  } catch {
    /* already gone */
  }
}

// ── Feed cache helpers ─────────────────────────────────────────────────────
export const FEED_TTL = 60 * 5; // 5 minutes

export function feedCacheKey({ country, category, sort, page, limit }) {
  return `feed:${country}:${category ?? "all"}:${sort ?? "newest"}:${page ?? 1}:${limit ?? 20}`;
}

export async function getFeedCache(key) {
  const raw = await safeRedis((c) => c.get(key));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // A corrupt entry shouldn't serve garbage to a feed
    await safeRedis((c) => c.del(key));
    return null;
  }
}

export async function setFeedCache(key, data) {
  await safeRedis((c) => c.setEx(key, FEED_TTL, JSON.stringify(data)));
}

/**
 * Bust every feed cache for a country when an ad is posted or removed.
 * SCAN rather than KEYS, so a large keyspace doesn't block Redis.
 */
export async function bustFeedCache(country) {
  await safeRedis(async (c) => {
    const pattern = `feed:${country}:*`;
    let cursor = 0;
    let guard = 0;

    do {
      const reply = await c.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = reply.cursor;
      if (reply.keys.length > 0) await c.del(reply.keys);

      // A cursor that never returns to 0 would spin forever. It
      // shouldn't happen, but an infinite loop inside a request handler
      // is not a failure mode worth leaving open.
      if (++guard > 1000) break;
    } while (cursor !== 0);
  });
}

// ── Shutdown ───────────────────────────────────────────────────────────────
export async function closeRedis() {
  try {
    await Promise.all([...subscribers].map((s) => closeSubscriber(s)));
    if (client?.isOpen) await client.quit();
  } catch {
    /* shutting down anyway */
  }
  connected = false;
  available = false;
}

// ═══════════════════════════════════════════════════════════════════════
// server.js — A LAST LINE OF DEFENCE
//
// This file is now safe. But any library that emits 'error' without a
// listener can end the process the same way, and you'd rather learn that
// from a log line than from a cold start.
//
// ADD near the top of server.js:
// ═══════════════════════════════════════════════════════════════════════
/*
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
  // Deliberately not exiting. A rejected promise in one request
  // shouldn't take down an API serving everyone else fine.
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
  // Node's advice is to exit, because state may be corrupt. But a
  // dropped socket is not corrupt state, and on Render an exit costs a
  // cold start and thirty seconds of 502s.
  //
  // If you start seeing genuinely odd behaviour after these, switch to
  // a graceful shutdown — close the server, then exit(1), and let Render
  // restart it cleanly.
});
*/
//
// And a clean shutdown, so Render's SIGTERM doesn't leave Upstash
// connections hanging:
/*
import { closeRedis } from "./lib/redis.js";

const shutdown = async (signal) => {
  console.log(`[server] ${signal} received, shutting down`);
  server.close(() => console.log("[server] http closed"));
  await closeRedis();
  setTimeout(() => process.exit(0), 3000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
*/

// ═══════════════════════════════════════════════════════════════════════
// SSE ROUTES — ONE LINE TO ADD
//
// Anywhere createSubscriberClient is called, close it when the request
// ends. An abandoned subscriber holds a connection open, and Upstash's
// free tier caps how many you get — so a few dropped SSE streams can
// exhaust the pool and look like Redis being down.
// ═══════════════════════════════════════════════════════════════════════
/*
import { createSubscriberClient, closeSubscriber } from "../lib/redis.js";

const sub = await createSubscriberClient();
if (sub) {
  await sub.subscribe(CHANNELS.statsUpdate, (raw) => {
    res.write(`data: ${raw}\n\n`);
  });
}

req.on("close", () => {
  closeSubscriber(sub);   // ← this
  res.end();
});
*/

// ═══════════════════════════════════════════════════════════════════════
// WHAT TO EXPECT AFTER THIS
//
// Leave the server idle for ten minutes, then make a request. The most
// you should see is:
//
//     Redis client error — falling back to DB: read ETIMEDOUT
//     Redis connected
//
// and the request succeeds. What you should not see is a crash.
//
// Repeated errors are throttled to one every thirty seconds, so a
// flapping connection logs a line now and then rather than a wall.
// ═══════════════════════════════════════════════════════════════════════
