// lib/socketHandler.js
// All Socket.IO event logic — extracted from server.js.
// Call registerSocketHandlers(io) once after creating the io instance.

import Message from "../models/chatModel.js";
import { buildRoomId } from "../controllers/chatController.js";

// Track online users: userId → socketId
const onlineUsers = new Map();

export function getOnlineUsers() {
  return onlineUsers;
}

export function registerSocketHandlers(io) {
  io.on("connection", (socket) => {
    // ── REGISTER ──────────────────────────────────────────────────────────────
    // Client sends their userId after connecting so we can track presence.
    socket.on("register_user", (userId) => {
      if (!userId) return;
      onlineUsers.set(String(userId), socket.id);
      // Broadcast updated online list to all clients
      io.emit("online_users", Array.from(onlineUsers.keys()));
    });

    // ── JOIN ROOM ─────────────────────────────────────────────────────────────
    // Client requests the room id and joins it.
    // Room name is built deterministically from both user ids.
    socket.on("join_room", ({ myId, otherId }) => {
      if (!myId || !otherId) return;
      const room = buildRoomId(myId, otherId);
      socket.join(room);
      socket.emit("room_joined", { room });
    });

    // ── SEND MESSAGE ──────────────────────────────────────────────────────────
    socket.on("send_message", async (data) => {
      try {
        const { room, sender, receiver, text, attachment } = data;
        if (!room || !sender || !receiver || !text?.trim()) return;

        const msg = await Message.create({
          room,
          sender,
          receiver,
          text: text.trim(),
          attachment: attachment ?? null,
          readBy: [String(sender)], // sender has "read" their own message
        });

        const populated = await msg.populate([
          { path: "sender", select: "username profilePicture" },
          { path: "receiver", select: "username profilePicture" },
        ]);

        io.to(room).emit("receive_message", populated);

        // Push live unread count to receiver — eliminates 30s polling in ChatNavBadge
        const receiverSocketId = onlineUsers.get(String(receiver));
        if (receiverSocketId) {
          // Count all unread messages for this receiver across all rooms
          const unreadCount = await Message.countDocuments({
            receiver: msg.receiver,
            readBy: { $ne: String(receiver) },
            deleted: false,
            deletedFor: { $ne: String(receiver) },
          });
          io.to(receiverSocketId).emit("unread_count", { count: unreadCount });
          io.to(receiverSocketId).emit("new_message_notification", {
            room,
            from: sender,
            preview: text.slice(0, 60),
          });
        }
      } catch (error) {
        console.error("send_message error:", error);
        socket.emit("error", { message: "Failed to send message" });
      }
    });

    // ── TYPING INDICATORS ─────────────────────────────────────────────────────
    socket.on("typing", ({ room, userId }) =>
      socket.to(room).emit("user_typing", { userId }),
    );
    socket.on("stop_typing", ({ room, userId }) =>
      socket.to(room).emit("user_stop_typing", { userId }),
    );

    // ── MARK READ ─────────────────────────────────────────────────────────────
    socket.on("mark_read", async ({ room, userId }) => {
      try {
        await Message.updateMany(
          { room, receiver: userId, readBy: { $ne: userId } },
          { $addToSet: { readBy: userId } },
        );
        io.to(room).emit("messages_read", { room, userId });

        // Push fresh unread count so badge updates instantly
        const unreadCount = await Message.countDocuments({
          receiver: userId,
          readBy: { $ne: userId },
          deleted: false,
          deletedFor: { $ne: userId },
        });
        socket.emit("unread_count", { count: unreadCount });
      } catch (error) {
        console.error("mark_read error:", error);
      }
    });

    // ── EDIT MESSAGE ──────────────────────────────────────────────────────────
    socket.on("edit_message", async ({ messageId, newText, sender }) => {
      try {
        if (!newText?.trim()) return;
        const message = await Message.findById(messageId);
        if (!message || String(message.sender) !== String(sender)) return;

        message.text = newText.trim();
        message.edited = true;
        await message.save();

        io.to(message.room).emit("message_edited", {
          _id: message._id,
          room: message.room,
          text: message.text,
          edited: true,
        });
      } catch (error) {
        console.error("edit_message error:", error);
      }
    });

    // ── DELETE FOR EVERYONE ───────────────────────────────────────────────────
    socket.on("delete_message", async ({ messageId, sender }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message || String(message.sender) !== String(sender)) return;

        message.deleted = true;
        message.text = "This message was deleted";
        await message.save();

        io.to(message.room).emit("message_deleted", {
          _id: message._id,
          room: message.room,
          deleted: true,
          text: message.text,
        });
      } catch (error) {
        console.error("delete_message error:", error);
      }
    });

    // ── DELETE FOR ME ONLY ────────────────────────────────────────────────────
    socket.on("delete_for_me", async ({ messageId, userId }) => {
      try {
        await Message.findByIdAndUpdate(messageId, {
          $addToSet: { deletedFor: String(userId) },
        });
        socket.emit("message_deleted_for_me", { messageId });
      } catch (error) {
        console.error("delete_for_me error:", error);
      }
    });

    // ── DELETE ENTIRE CHAT (for everyone) ─────────────────────────────────────
    socket.on("delete_chat", async ({ room, userId }) => {
      try {
        // Hard-delete if user owns both sides, otherwise soft-delete for self
        await Message.updateMany(
          { room },
          { $addToSet: { deletedFor: String(userId) } },
        );
        io.to(room).emit("chat_deleted", { room });
      } catch (error) {
        console.error("delete_chat error:", error);
      }
    });

    // ── REACT TO MESSAGE ──────────────────────────────────────────────────────
    // Lightweight emoji reaction (stored in-memory, not persisted — extend later)
    socket.on("react_message", ({ room, messageId, emoji, userId }) => {
      io.to(room).emit("message_reaction", { messageId, emoji, userId });
    });

    // ── DISCONNECT ────────────────────────────────────────────────────────────
    socket.on("disconnect", () => {
      onlineUsers.forEach((socketId, userId) => {
        if (socketId === socket.id) {
          onlineUsers.delete(userId);
        }
      });
      io.emit("online_users", Array.from(onlineUsers.keys()));
    });
  });
}
