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
import marketerRoutes, { updatesRouter } from "./routes/marketerRoute.js";
import adBoostPaymentRoutes from "./routes/adBoostPaymentRoute.js";
import adminRoutes from "./routes/adminRoutes.js";

import authMiddleware from "./middleware/authMiddleWare.js";
import { checkReferralCode } from "./controllers/paymentController.js";
import { connectRedis } from "./lib/redis.js";
import { startSubscriptionCron } from "./cron/subscriptionExpiry.js";
import { registerSocketHandlers } from "./lib/socketHandler.js"; // ← extracted

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
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  process.env.NEXT_PUBLIC_APP_URL,
  "https://www.smilebabahub.com",
].filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
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
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500 }));
// ── Proxy trust ───────────────────────────────────────────────────────────────
// Stack: User → Cloudflare (1 hop) → Render load balancer (1 hop) → app
// Setting to 2 means Express trusts exactly 2 proxy hops, not the whole internet.
// express-rate-limit rejects "true" because it allows IP spoofing via XFF headers.
// We bypass that concern entirely by using resolveClientIP() as the rate-limit
// key generator — it reads CF-Connecting-IP first, which Cloudflare sets and
// users cannot spoof, so the key is always the real visitor IP.
app.set("trust proxy", 2);
 
// ── Rate limiting ─────────────────────────────────────────────────────────────
import { resolveClientIP } from "./lib/resolveIp.js";
 
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,   // 15 minutes
    max:      500,               // requests per window per IP
    // Use our own IP resolver so rate limiting keys on the real visitor IP,
    // not the Cloudflare or Render proxy IP.
    keyGenerator: (req) => resolveClientIP(req) || req.ip || "unknown",
    // Skip validation warning — we handle proxy trust correctly above.
    validate:     { trustProxy: false },
    standardHeaders: true,
    legacyHeaders:   false,
  })
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
app.get(
  "/smilebaba/payments/referral/:code",
  authMiddleware,
  checkReferralCode,
);

// ── Socket.IO ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

registerSocketHandlers(io); // all socket logic lives in socketHandler.js

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
