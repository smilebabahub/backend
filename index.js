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

import authMiddleware from "./middleware/authMiddleWare.js";
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

// ── CORS ──────────────────────────────────────────────────────────────────────
// Exact origins always allowed
const ALLOWED_ORIGINS_EXACT = [
  "http://localhost:3000",
  "http://localhost:3001",
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
app.use(helmet());
app.use(helmet({ crossOriginResourcePolicy: false }));
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
    // ipKeyGenerator normalises IPv6 addresses so users can't bypass limits
    // by switching between IPv4 and IPv6 representations of the same address.
    // We pass it the real visitor IP (from CF-Connecting-IP) not the proxy IP.
    keyGenerator: (req) => {
      const ip = resolveClientIP(req) || req.ip || "unknown";
      return ipKeyGenerator(ip);
    },
    validate: { trustProxy: false },
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// ── Routes ────────────────────────────────────────────────────────────────────
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
  // Only handle socket.io upgrade requests — not SSE routes
  allowEIO3: true,
});

// Prevent Socket.IO from intercepting SSE connections on /smilebaba/updates.
// Without this guard, Socket.IO's "upgrade" event fires on any HTTP upgrade
// header, returning 426 to the EventSource client.
server.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.startsWith("/smilebaba/updates")) {
    // SSE doesn't use WebSocket — destroy the upgrade attempt
    socket.destroy();
  }
  // All other upgrades (Socket.IO) are handled by the io engine automatically
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

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/smilebaba/health", (_req, res) =>
  res.json({ status: "ok", ts: new Date().toISOString() }),
);

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
