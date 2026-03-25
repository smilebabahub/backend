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
import productRoute from "./routes/productRoute.js";
import paymentRoute from "./routes/paymentRoute.js";
import chatRoute from "./routes/chatRoute.js";
import Message from "./models/Message.js";

import rateLimit from "express-rate-limit";
import fs from "fs";
import mongoose from "mongoose";

// CONFIG
const app = express();

if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const server = http.createServer(app);

const allowedOrigins = ["http://localhost:3000", "https://smilebabahub.com"];

app.use(
  "/smilebaba/payments/webhook",
  express.raw({ type: "application/json" }),
);

app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true, limit: "30mb" }));

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    exposedHeaders: ["set-cookie"],
  }),
);

app.use(helmet());
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan("common"));
app.use(cookieParser());

app.use("/uploads", express.static("uploads"));

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
  }),
);

app.set("trust proxy", 1);

// ROUTES
app.use("/smilebaba/auth", authRoute);
app.use("/smilebaba/products", productRoute);
app.use("/smilebaba/payments", paymentRoute);
app.use("/smilebaba/chat", chatRoute);

const PORT = process.env.PORT || 3001;

// SOCKET.IO
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

const onlineUsers = new Map();

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // REGISTER USER
  socket.on("register_user", (userId) => {
    onlineUsers.set(userId, socket.id);
  });

  // JOIN ROOM

  //so for the room, we can use a combination of sender and receiver ids to create a unique room for each pair of users. So on the frontend, when a user clicks on a chat with another user, we get the users _id that comes from his database when he registered and combine it with the _id of the user he wants to chat with to create a unique room name. For example, if user A has _id "userA123" and user B has _id "userB456", we can create a room name like "userA123_userB456" or "userB456_userA123" (the order doesn't matter as long as it's consistent). This way, both users will join the same room when they start a chat, and we can easily manage their messages in that room.  also when a chat is clicked, the frontend should make a call to the backend to check the database if a chat exists between the two users. If it does, it should return the room name to the frontend so that the frontend can join that room. If it doesn't exist, the backend can create a new room name based on the user ids and return it to the frontend for joining.

  socket.on("join_room", (room) => {
    socket.join(room);
    console.log(`User joined room: ${room}`);
  });

  // SEND MESSAGE
  socket.on("send_message", async (data) => {
    try {
      const { room, sender, receiver, text } = data;

      if (!room || !sender || !receiver || !text) return;

      const newMessage = await Message.create({
        room,
        sender,
        receiver,
        text,
      });

      io.to(room).emit("receive_message", newMessage);
    } catch (error) {
      console.error("Send message error:", error);
    }
  });

  // EDIT MESSAGE
  socket.on("edit_message", async ({ messageId, newText, sender }) => {
    try {
      const message = await Message.findById(messageId);
      if (!message) return;

      if (message.sender !== sender) return;

      message.text = newText;
      message.edited = true;

      await message.save();

      io.to(message.room).emit("message_edited", message);
    } catch (error) {
      console.error("Edit message error:", error);
    }
  });

  // DELETE FOR EVERYONE
  socket.on("delete_message", async ({ messageId, sender }) => {
    try {
      const message = await Message.findById(messageId);
      if (!message) return;

      if (message.sender !== sender) return;

      message.text = "This message was deleted";
      message.deleted = true;

      await message.save();

      io.to(message.room).emit("message_deleted", message);
    } catch (error) {
      console.error("Delete message error:", error);
    }
  });

  // DELETE FOR ME
  socket.on("delete_for_me", async ({ messageId, userId }) => {
    try {
      const message = await Message.findById(messageId);
      if (!message) return;

      if (!message.deletedFor.includes(userId)) {
        message.deletedFor.push(userId);
      }

      await message.save();

      socket.emit("message_deleted_for_me", { messageId });
    } catch (error) {
      console.error("Delete for me error:", error);
    }
  });

  // DELETE ENTIRE CHAT
  socket.on("delete_chat", async ({ room }) => {
    try {
      await Message.deleteMany({ room });

      io.to(room).emit("chat_deleted", { room });
    } catch (error) {
      console.error("Delete chat error:", error);
    }
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    console.log("User disconnected");

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
      console.log(`Server running on port ${PORT}`);
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
