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
//import adRoute from "./routes/adRoute.js";
import productRoute from "./routes/productRoute.js";
import paymentRoute from "./routes/paymentRoute.js";
import chatRoute from "./routes/chatRoute.js";
import Message from "./models/Message.js";
import rateLimit from "express-rate-limit";


//CONFIGURATIONS
const app = express();

const server = http.createServer(app);

app.use(express.json());
app.use(
  cors({
    origin: ["http://localhost:3000", "https://smilebabahub.com"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use(helmet());
app.use(helmet.crossOriginResourcePolicy({ policy: "cross-origin" }));
app.use(morgan("common"));
app.use(cookieParser());


const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
});

app.use(limiter);

app.set("trust proxy", true);
// ROUTES

app.use("/smilebaba/auth", authRoute);
app.use("/smilebaba/products", productRoute);
app.use("/smilebaba/payment", paymentRoute);
app.use("/smilebaba/chat", chatRoute);

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
