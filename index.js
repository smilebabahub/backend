import dotenv from "dotenv";
dotenv.config();

import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import cors from "cors";
import cookieParser from "cookie-parser";
import http from "http";
import { Server } from "socket.io";

import connectDB from "./config/db.js";
import authRoute from "./routes/authRoute.js";
import adRoute from "./routes/adRoute.js";
import productRoute from "./routes/productRoute.js";
import paymentRoute from "./routes/paymentRoute.js";
import chatRoute from "./routes/chatRoute.js";
import Message from "./models/Message.js";
import rateLimit from "express-rate-limit";
import { startSubscriptionCron } from "./cron/subscriptionExpiry.js";
import marketerRoutes, { updatesRouter } from "./routes/marketerRoute.js";
import { checkReferralCode } from "./controllers/paymentController.js";

import fs from "fs";
import authMiddleware from "./middleware/authMiddleWare.js";
import adBoostPaymentRoutes from "./routes/adBoostPaymentRoute.js";
import orderRoutes from "./routes/orderRoute.js";
import bookingRoutes from "./routes/bookingRoute.js";



//CONFIGURATIONS
const app = express();

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const server = http.createServer(app);

app.use(
  "/smilebaba/payments/gh/webhook",
  express.raw({ type: "application/json" }),
);
app.use(
  "/smilebaba/payments/ng/webhook",
  express.raw({ type: "application/json" }),
);
app.use(
  "/smilebaba/payments/intl/webhook",
  express.raw({ type: "application/json" }),
);

app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true, limit: "30mb" }));
const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "https://smilebabahub.com", 
  "https://www.smilebabahub.com",
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      if (ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`CORS blocked origin: ${origin}`);
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: true, 
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(helmet());
app.use(
  helmet({
    crossOriginResourcePolicy: false,
  }),
);
app.use(morgan("common"));
app.use(cookieParser());

app.use("/uploads", express.static("uploads"));


const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
});

app.use(limiter);
app.set("trust proxy", 1);

// ROUTES

app.use("/smilebaba/auth", authRoute);
app.use("/smilebaba/products", productRoute);
app.use("/smilebaba/payments", paymentRoute);
app.use("/smilebaba/chat", chatRoute);
app.use("/smilebaba/marketers", marketerRoutes);
app.use("/smilebaba/updates",   updatesRouter);
app.get("/smilebaba/payments/referral/:code", authMiddleware, checkReferralCode);
app.use("/smilebaba/ads", adRoute);
app.use("/smilebaba/payments/boost", adBoostPaymentRoutes);
app.use("/smilebaba/orders", orderRoutes);
app.use("/smilebaba/bookings", bookingRoutes);

// ── Redis connection ────────────────────────────────────────────────────────
import { connectRedis } from "./lib/redis.js";
await connectRedis();

// ── Cron ───────────────────────────────────────────────────────────────────
startSubscriptionCron();

app.get("/", (req, res) => {
  res.send("SmileBabaHub API Running");
});

const PORT = process.env.PORT || 3001;

//creating socket server

const io = new Server(server, {
  cors: {
    origin: [
      "http://localhost:5173",
      "http://localhost:3000",
      "https://smilebabahub.com",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Join private room
  socket.on("join_room", (room) => {
    socket.join(room);
    console.log(`User joined room: ${room}`);
  });

  // Send private message
  socket.on("send_message", async (data) => {
    try {
      const { room, sender, receiver, text } = data;

      if (!room || !sender || !receiver || !text) {
        return;
      }

      const newMessage = await Message.create({
        room,
        sender,
        receiver,
        text,
        createdAt: new Date(),
      });

      io.to(room).emit("receive_message", newMessage);
    } catch (error) {
      console.error("Message error:", error);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected");
  });
});


const onlineUsers = new Map();

io.on("connection", (socket) => {
  socket.on("register_user", (userId) => {
    onlineUsers.set(userId, socket.id);
  });

  socket.on("disconnect", () => {
    onlineUsers.forEach((value, key) => {
      if (value === socket.id) {
        onlineUsers.delete(key);
      }
    });
  });
});

// START SERVER
const start = async () => {
  try {
    await connectDB(process.env.MONGO_URI);
    server.listen(PORT, () => {
      console.log(` Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

start();


const shutdown = async () => {
  console.log("Shutting down server...");

  await mongoose.connection.close();

  console.log(" MongoDB connection closed");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
