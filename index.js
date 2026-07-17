// server.js — SmileBaba Hub backend
// Socket.IO chat logic is now in lib/socketHandler.js
// Chat REST API is in controllers/chatController.js + routes/chatRoute.js

import dotenv from "dotenv";
dotenv.config();

import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import cors from "cors";
import cookieParser from "cookie-parser";
import http from "http";
import { Server } from "socket.io";
import rateLimit from "express-rate-limit";
import mongoose from "mongoose";
import fs from "fs";

import connectDB from "./config/db.js";
import authRoute from "./routes/authRoute.js";
import adRoute from "./routes/adRoute.js";
import productRoute from "./routes/productRoute.js";
import paymentRoute from "./routes/paymentRoute.js";
import chatRoute from "./routes/chatRoute.js";
import orderRoutes from "./routes/orderRoute.js";
import bookingRoutes from "./routes/bookingRoute.js";
import adminRoutes from "./routes/adminRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import marketerRoutes, { updatesRouter } from "./routes/marketerRoute.js";
import adBoostPaymentRoutes from "./routes/adBoostPaymentRoute.js";
import newsRoutes from "./routes/newsRoutes.js";
import promotionRoutes from "./routes/promotionRoutes.js";
import adminPromotionRoutes from './routes/admin-promotions.js'

import { authenticate as authMiddleware } from "./middleware/authMiddleWare.js";
import { checkReferralCode } from "./controllers/paymentController.js";
import { connectRedis } from "./lib/redis.js";
import { startSubscriptionCron } from "./cron/subscriptionExpiry.js";
import {
  registerSocketHandlers,
  notifyUser,
  onlineUsers,
  setIO,
} from "./lib/socketHandler.js";


// ── Setup ─────────────────────────────────────────────────────────────────────
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

const app = express();
const server = http.createServer(app);

// ── Flutterwave webhooks need raw body BEFORE express.json() ─────────────────
const WEBHOOK_PATHS = [
  "/smilebaba/payments/gh/webhook",
  "/smilebaba/payments/ng/webhook",
  "/smilebaba/payments/intl/webhook",
  "/smilebaba/payments/boost/gh/webhook",
  "/smilebaba/payments/boost/ng/webhook",
  "/smilebaba/payments/boost/intl/webhook",
];
WEBHOOK_PATHS.forEach((path) =>
  app.use(path, express.raw({ type: "application/json" })),
);

// ── Body parsers ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true, limit: "30mb" }));
app.use(cookieParser());

// ── Required env var check ───────────────────────────────────────────────────
// Fail loud at startup rather than silently returning 500s in production.
const REQUIRED_ENV = [
  "MONGO_URI",
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
  "FLW_SECRET_KEY", // OR FLW_SECRET_KEY_GH / FLW_SECRET_KEY_NG
  "FLW_WEBHOOK_SECRET", // OR FLW_WEBHOOK_SECRET_GH / FLW_WEBHOOK_SECRET_NG
];


const missing = REQUIRED_ENV.filter((k) => {
  // Allow either the base key OR a country-specific variant
  if (k === "FLW_SECRET_KEY") {
    return (
      !process.env.FLW_SECRET_KEY &&
      !process.env.FLW_SECRET_KEY_GH &&
      !process.env.FLW_SECRET_KEY_NG
    );
  }
  if (k === "FLW_WEBHOOK_SECRET") {
    return (
      !process.env.FLW_WEBHOOK_SECRET &&
      !process.env.FLW_WEBHOOK_SECRET_GH &&
      !process.env.FLW_WEBHOOK_SECRET_NG
    );
  }
  return !process.env[k];
});

if (missing.length) {
  console.error(
    "\n[server] ❌ Missing required environment variables:\n" +
      missing.map((k) => `  • ${k}`).join("\n") +
      "\n\nAdd them to Render → Environment → Add environment variable\n",
  );
  // Don't crash in dev — just warn
  if (process.env.NODE_ENV === "production") process.exit(1);
}


// ── CORS ──────────────────────────────────────────────────────────────────────
// Exact origins always allowed
// Extra origins from env — comma-separated, e.g.:
// EXTRA_ORIGINS=http://localhost:5174,http://localhost:5175
const extraOrigins = (process.env.EXTRA_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const ALLOWED_ORIGINS_EXACT = [
  "http://localhost:3000", // Next.js frontend
  "http://localhost:3001", // backend (self / SSR)
  "http://localhost:3002", // backend (self / SSR)
  "http://localhost:5173", // Vite dev server (default)
  "http://localhost:5174", // Vite marketer dashboard
  "http://localhost:5175", // Vite fallback port
  "http://localhost:4173", // Vite preview
  "http://localhost:8081",
  ...extraOrigins,
  "https://smilebabahub.com",
  "https://www.smilebabahub.com",
  "https://smilebabahub.vercel.app", // Vercel production
  process.env.NEXT_PUBLIC_APP_URL, // from env (e.g. custom domain)
  process.env.FRONTEND_URL, // extra override if needed
].filter(Boolean);

// Pattern-matched origins (Vercel preview deployments)
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/smilebabahub-[a-z0-9-]+-tettehs-projects\.vercel\.app$/,
  /^https:\/\/smilebabahub.*\.vercel\.app$/,
];

function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / non-browser requests
  if (ALLOWED_ORIGINS_EXACT.includes(origin)) return true;
  if (ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin))) return true;
  return false;
}


app.use(
  cors({
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      console.warn(`CORS blocked: ${origin}`);
      cb(new Error(`Origin ${origin} not allowed`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// ── Security / logging ────────────────────────────────────────────────────────
// Single helmet call — crossOriginResourcePolicy: false so Cloudinary
// images can load cross-origin without being blocked
// Helmet — disable HSTS and COOP/COEP in dev to avoid 426s on http://localhost.
// HSTS in particular makes browsers cache "always upgrade to HTTPS" which then
// breaks http requests for the lifetime of the cache.
app.use(helmet({
  crossOriginResourcePolicy:   false,
  crossOriginOpenerPolicy:     false,
  crossOriginEmbedderPolicy:   false,
  // HSTS only in production
  hsts: process.env.NODE_ENV === "production"
    ? { maxAge: 31536000, includeSubDomains: true }
    : false,
  // Disable Content-Security-Policy in dev — it commonly breaks Next dev HMR
  contentSecurityPolicy: process.env.NODE_ENV === "production",
}));
app.use(morgan("common"));
app.use("/uploads", express.static("uploads"));

// ── Proxy trust ───────────────────────────────────────────────────────────────
// Stack: User → Cloudflare (1 hop) → Render load balancer (1 hop) → app
app.set("trust proxy", 2);

// ── Real IP helper (inlined — no separate file needed) ───────────────────────
function resolveClientIP(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf && isPublicIP(cf)) return cf.trim();
  const xri = req.headers["x-real-ip"];
  if (xri && isPublicIP(xri)) return xri.trim();
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first && isPublicIP(first)) return first;
  }
  return req.socket?.remoteAddress ?? "";
}

function isPublicIP(ip) {
  if (!ip) return false;
  if (ip === "::1" || ip === "127.0.0.1") return false;
  if (/^10\./.test(ip)) return false;
  if (/^192\.168\./.test(ip)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  return true;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
import { ipKeyGenerator } from "express-rate-limit";

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    keyGenerator: (req) => {
      const ip = resolveClientIP(req) || req.ip || "127.0.0.1";
      try {
        return ipKeyGenerator(ip);
      } catch {
        return ip;
      }
    },
    standardHeaders: true,
    legacyHeaders: false,
    // CRITICAL: skip rate limiting for CORS preflight (OPTIONS) requests.
    // Otherwise preflights count against the user's quota and once blocked,
    // every subsequent request fails because the browser can't get past
    // preflight. Also skip health checks from uptime monitors.
    skip: (req) => req.method === "OPTIONS" || req.url === "/smilebaba/health",
  }),
);

// ── Routes ────────────────────────────────────────────────────────────────────

// ── /admin/live — SSE endpoint, accepts ?token= for EventSource clients ────
// Returns 204 for non-admin/marketer tokens to stop the browser retry loop.
app.get("/smilebaba/admin/live", async (req, res) => {
  const rawToken = req.query.token ?? req.headers.authorization?.split(" ")[1];
  if (!rawToken) return res.status(204).end();

  try {
    const jwt = (await import("jsonwebtoken")).default;
    const decoded = jwt.verify(rawToken, process.env.JWT_ACCESS_SECRET);
    const userId = decoded.userId ?? decoded.id;
    // Check if admin — import User model lazily to avoid circular deps
    const { default: User } = await import("./models/user.js");
    const user = await User.findById(userId).select("email role").lean();
    const adminEmails = (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim());
    if (!user || (user.role !== "admin" && !adminEmails.includes(user.email))) {
      return res.status(204).end(); // not admin — silence the client
    }
    // Valid admin — delegate to analytics controller
    const { getLiveAnalytics } =
      await import("./controllers/analyticsController.js");
    req.user = { ...decoded, userId };
    return getLiveAnalytics(req, res);
  } catch {
    // Invalid token (wrong secret, expired, marketer token) — return 204 not 401
    // so EventSource treats it as connected and stops the retry loop
    return res.status(204).end();
  }
});

app.use("/smilebaba/auth", authRoute);
app.use("/smilebaba/ads", adRoute);
app.use("/smilebaba/products", productRoute);
app.use("/smilebaba/payments", paymentRoute);
app.use("/smilebaba/payments/boost", adBoostPaymentRoutes);
app.use("/smilebaba/marketers", marketerRoutes);
app.use("/smilebaba/updates", updatesRouter);
app.use("/smilebaba/chat", chatRoute); // ← REST chat API
app.use("/smilebaba/orders", orderRoutes);
app.use("/smilebaba/bookings", bookingRoutes);
app.use("/smilebaba/admin", adminRoutes);
app.use("/smilebaba/analytics", analyticsRoutes); // page view tracking
app.use("/smilebaba", newsRoutes);
app.use("/smilebaba/promote", promotionRoutes);
app.use("/smilebaba/admin/promotions", adminPromotionRoutes);

// ── Health check — used by BackendWakeUp component + uptime monitors ─────
// Returns 200 immediately — just proves the server is awake.
app.get("/smilebaba/health", (_req, res) =>
  res
    .status(200)
    .json({
      status: "ok",
      uptime: Math.floor(process.uptime()),
      ts: Date.now(),
    }),
);
app.get(
  "/smilebaba/payments/referral/:code",
  authMiddleware,
  checkReferralCode,
);

// ── Socket.IO ─────────────────────────────────────────────────────────────────
// allowUpgrades: true (default) but we guard SSE routes from being
// hijacked by Socket.IO's upgrade handler by checking the path.
// Socket.IO only handles WebSocket upgrades on its own namespace paths.
const io = new Server(server, {
  cors: {
    origin: (origin, cb) => {
      if (isAllowedOrigin(origin)) return cb(null, true);
      cb(new Error(`Socket.IO origin ${origin} not allowed`));
    },
    methods: ["GET", "POST"],
    credentials: true,
  },
  allowEIO3: true,
  pingTimeout: 60000, // 60s before considering connection dead
  pingInterval: 25000, // ping every 25s
  upgradeTimeout: 10000, // wait 10s for transport upgrade
  maxHttpBufferSize: 1e6, // 1MB max message
  transports: ["polling", "websocket"], // polling first on server too
});

// Prevent Socket.IO from intercepting SSE connections on /smilebaba/updates.
// Without this guard, Socket.IO's "upgrade" event fires on any HTTP upgrade
// header, returning 426 to the EventSource client.
server.on("upgrade", (req, socket, head) => {
  // SSE on /smilebaba/updates uses plain HTTP, not WebSocket. If a client
  // sends an Upgrade header here, kill the upgrade so Socket.IO doesn't
  // intercept it and Express can respond normally.
  if (req.url && req.url.startsWith("/smilebaba/updates")) {
    socket.destroy();
    return;
  }
  // Don't intercept HTTPS upgrades — let Node/Express handle those.
  // Don't destroy upgrades for any other path — Socket.IO handles its own.
});

registerSocketHandlers(io);
setIO(io); // wire pushToUser singleton in socketHandler

// ── Expose io so controllers can push real-time events ────────────────────
export { io };

// ── Infrastructure ────────────────────────────────────────────────────────────
await connectRedis().catch((e) =>
  console.warn("Redis unavailable — SSE disabled:", e.message),
);
startSubscriptionCron();

// ── 404 + global error ────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ message: "Route not found" }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: err.message ?? "Internal server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT ?? 3001;

const start = async () => {
  try {
    await connectDB(process.env.MONGO_URI);
    server.listen(PORT, () =>
      console.log(`✓ SmileBaba API + Socket.IO running on port ${PORT}`),
    );
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};
start();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = async () => {
  await mongoose.connection.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
