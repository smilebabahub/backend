// lib/socketHandler.js — AUTHENTICATION
//
// ═══════════════════════════════════════════════════════════════════════
// THE HOLE
// ═══════════════════════════════════════════════════════════════════════
//
// Socket.IO currently trusts whatever the client sends:
//
//     socket.on("register_user", (userId) => {
//       onlineUsers.set(String(userId), socket.id);   // ← any id
//     });
//
//     socket.on("send_message", async (data) => {
//       const { room, sender, receiver, text } = data;
//       await Message.create({ sender, receiver, text });   // ← any sender
//     });
//
// There is no token anywhere in that path. So with a browser console and
// your socket URL, anyone can:
//
//   · Register as any user id and receive their unread counts and
//     new-message notifications
//   · Send messages that appear to come from any vendor
//   · Join any room by guessing buildRoomId, which is a sorted pair of
//     user ids — both of which are returned by your public ad endpoints
//     in `postedBy._id`
//   · Mark other people's messages as read
//   · Delete any message: delete_message checks that sender matches, but
//     the sender is supplied by the caller
//
// Nothing here requires skill. The room id is deterministic and the user
// ids are public.
//
// ═══════════════════════════════════════════════════════════════════════
// THE FIX
// ═══════════════════════════════════════════════════════════════════════
//
// The identity comes from a verified JWT at handshake, and every handler
// reads it from the socket instead of from the payload. The client can
// still send a `sender` field; it's simply ignored.
//
// This is a breaking change for any client that doesn't send a token, so
// deploy the mobile and web socket changes at the same time.

import jwt from "jsonwebtoken";
import Message from "../models/chatModel.js";
import {
  maybeNotifyByEmail,
  cancelPendingNotification,
} from "../lib/chatNotifier.js";
import { buildRoomId } from "../controllers/chatController.js";

export const onlineUsers = new Map();

export function getOnlineUsers() {
  return onlineUsers;
}

/**
 * Runs once per connection, before any event handler.
 *
 * A socket that can't prove who it is doesn't get connected at all —
 * which is simpler than checking on every event and forgetting one.
 */
function authenticateSocket(socket, next) {
  const raw =
    socket.handshake.auth?.token ??
    socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, "") ??
    socket.handshake.query?.token;

  if (!raw) {
    return next(new Error("UNAUTHORISED"));
  }

  try {
    const decoded = jwt.verify(String(raw), process.env.JWT_ACCESS_SECRET);
    if (!decoded?.userId) return next(new Error("UNAUTHORISED"));

    // The only identity that matters from here on
    socket.userId = String(decoded.userId);
    return next();
  } catch {
    return next(new Error("UNAUTHORISED"));
  }
}

/** Only rooms this socket is actually part of. */
function ownsRoom(socket, room) {
  return typeof room === "string" && room.includes(socket.userId);
}

/**
 * A chat message is short. Fifty a minute is far more than a person
 * types and far less than a script sends.
 */
const RATE = { windowMs: 60_000, max: 50 };

function underRateLimit(socket) {
  const now = Date.now();
  if (!socket._rate || now - socket._rate.start > RATE.windowMs) {
    socket._rate = { start: now, count: 0 };
  }
  socket._rate.count += 1;
  return socket._rate.count <= RATE.max;
}

export function registerSocketHandlers(io) {
  io.use(authenticateSocket);

  io.on("connection", (socket) => {
    const myId = socket.userId;

    // ── Presence ────────────────────────────────────────────────────
    // No register_user event any more. The token said who this is, so
    // registering is automatic and can't be spoofed.
    onlineUsers.set(myId, socket.id);
    io.emit("online_users", Array.from(onlineUsers.keys()));

    // Kept so older clients that still emit it don't error. It does
    // nothing — the identity is already set.
    socket.on("register_user", () => {
      socket.emit("registered", { userId: myId });
    });

    // ── Join room ───────────────────────────────────────────────────
    socket.on("join_room", ({ otherId }) => {
      if (!otherId || String(otherId) === myId) return;

      // Built from the verified id, not from anything the client sent,
      // so nobody can join a room they aren't in
      const room = buildRoomId(myId, otherId);
      socket.join(room);
      socket.emit("room_joined", { room });
    });

    // ── Send ────────────────────────────────────────────────────────
    socket.on("send_message", async (data) => {
      try {
        const { receiver, text, attachment } = data ?? {};
        if (!receiver || !text?.trim()) return;
        if (String(receiver) === myId) return;

        if (!underRateLimit(socket)) {
          socket.emit("error", { message: "Slow down a moment." });
          return;
        }

        // Derived, never taken from the payload. A client claiming to be
        // someone else is simply ignored.
        const room = buildRoomId(myId, receiver);

        const msg = await Message.create({
          room,
          sender: myId,
          receiver,
          text: String(text).trim().slice(0, 4000),
          attachment: attachment ?? null,
          readBy: [myId],
        });

        const populated = await msg.populate([
          { path: "sender", select: "username profilePicture" },
          { path: "receiver", select: "username profilePicture" },
        ]);

        // The sender may not have joined the room yet on a reconnect
        socket.join(room);
        io.to(room).emit("receive_message", populated);

        const receiverSocketId = onlineUsers.get(String(receiver));
        if (receiverSocketId) {
          const unreadCount = await Message.countDocuments({
            receiver: msg.receiver,
            readBy: { $ne: String(receiver) },
            deleted: false,
            deletedFor: { $ne: String(receiver) },
          });
          io.to(receiverSocketId).emit("unread_count", { count: unreadCount });
          io.to(receiverSocketId).emit("new_message_notification", {
            room,
            from: myId,
            preview: String(text).slice(0, 60),
          });
        }

        maybeNotifyByEmail({
          receiverId: receiver,
          senderId: myId,
          isReceiverOnline: Boolean(receiverSocketId),
        });
      } catch (error) {
        console.error("send_message error:", error.message);
        socket.emit("error", { message: "Failed to send message" });
      }
    });

    // ── Typing ──────────────────────────────────────────────────────
    socket.on("typing", ({ room }) => {
      if (!ownsRoom(socket, room)) return;
      socket.to(room).emit("user_typing", { userId: myId });
    });

    socket.on("stop_typing", ({ room }) => {
      if (!ownsRoom(socket, room)) return;
      socket.to(room).emit("user_stop_typing", { userId: myId });
    });

    // ── Mark read ───────────────────────────────────────────────────
    socket.on("mark_read", async ({ room }) => {
      try {
        if (!ownsRoom(socket, room)) return;

        // receiver: myId means you can only ever mark your own messages
        // read, whatever room you name
        await Message.updateMany(
          { room, receiver: myId, readBy: { $ne: myId } },
          { $addToSet: { readBy: myId } },
        );
        io.to(room).emit("messages_read", { room, userId: myId });

        const unreadCount = await Message.countDocuments({
          receiver: myId,
          readBy: { $ne: myId },
          deleted: false,
          deletedFor: { $ne: myId },
        });
        socket.emit("unread_count", { count: unreadCount });

        cancelPendingNotification?.(myId);
      } catch (error) {
        console.error("mark_read error:", error.message);
      }
    });

    // ── Edit ────────────────────────────────────────────────────────
    socket.on("edit_message", async ({ messageId, newText }) => {
      try {
        if (!newText?.trim()) return;

        // The ownership check is in the query, so there's no window
        // between reading and writing
        const message = await Message.findOneAndUpdate(
          { _id: messageId, sender: myId, deleted: false },
          { text: String(newText).trim().slice(0, 4000), edited: true },
          { new: true },
        );
        if (!message) return;

        io.to(message.room).emit("message_edited", {
          _id: message._id,
          room: message.room,
          text: message.text,
          edited: true,
        });
      } catch (error) {
        console.error("edit_message error:", error.message);
      }
    });

    // ── Delete for everyone ─────────────────────────────────────────
    socket.on("delete_message", async ({ messageId }) => {
      try {
        const message = await Message.findOneAndUpdate(
          { _id: messageId, sender: myId },
          { deleted: true, text: "This message was deleted" },
          { new: true },
        );
        if (!message) return;

        io.to(message.room).emit("message_deleted", {
          _id: message._id,
          room: message.room,
          deleted: true,
          text: message.text,
        });
      } catch (error) {
        console.error("delete_message error:", error.message);
      }
    });

    // ── Delete for me ───────────────────────────────────────────────
    socket.on("delete_for_me", async ({ messageId }) => {
      try {
        // Only in a room you're part of — otherwise this is a way to
        // probe which message ids exist
        const message = await Message.findById(messageId).select("room").lean();
        if (!message || !message.room.includes(myId)) return;

        await Message.findByIdAndUpdate(messageId, {
          $addToSet: { deletedFor: myId },
        });
        socket.emit("message_deleted_for_me", { messageId });
      } catch (error) {
        console.error("delete_for_me error:", error.message);
      }
    });

    // ── Delete a whole conversation, for me ─────────────────────────
    socket.on("delete_chat", async ({ room }) => {
      try {
        if (!ownsRoom(socket, room)) return;
        await Message.updateMany({ room }, { $addToSet: { deletedFor: myId } });
        socket.emit("chat_deleted", { room });
      } catch (error) {
        console.error("delete_chat error:", error.message);
      }
    });

    // ── Reactions ───────────────────────────────────────────────────
    socket.on("react_message", ({ room, messageId, emoji }) => {
      if (!ownsRoom(socket, room)) return;
      io.to(room).emit("message_reaction", { messageId, emoji, userId: myId });
    });

    // ── Disconnect ──────────────────────────────────────────────────
    socket.on("disconnect", () => {
      // Only remove if this is still the current socket — a reconnect
      // can otherwise delete the entry the new socket just made
      if (onlineUsers.get(myId) === socket.id) {
        onlineUsers.delete(myId);
      }
      io.emit("online_users", Array.from(onlineUsers.keys()));
    });
  });
}

export function notifyUser(io, userId, event, data = {}) {
  const socketId = onlineUsers.get(String(userId));
  if (socketId) io.to(socketId).emit(event, data);
}

let _io = null;

export function setIO(io) {
  _io = io;
}

export function pushToUser(userId, event, data = {}) {
  if (!_io || !userId) return;
  const socketId = onlineUsers.get(String(userId));
  if (socketId) _io.to(socketId).emit(event, data);
}

// ═══════════════════════════════════════════════════════════════════════
// CLIENT CHANGES — DEPLOY THESE TOGETHER
//
// The server now rejects a socket with no token, so an old client stops
// connecting the moment this ships.
// ═══════════════════════════════════════════════════════════════════════
//
// mobile/src/lib/chat/useChat.ts:
/*
    

    

    const socket = io(SOCKET_URL, {
      transports: ["websocket"],
      auth: { token },            // ← the handshake reads this
      reconnection: true,
    });

    // register_user is no longer needed — the token identifies you.
    // Leaving it in is harmless.

    // join_room no longer takes myId
    socket.emit("join_room", { otherId });

    // send_message no longer takes sender
    socket.emit("send_message", { receiver, text, attachment });

    // typing / stop_typing / mark_read no longer take userId
    socket.emit("typing", { room });
    socket.emit("mark_read", { room });

    // edit / delete no longer take sender or userId
    socket.emit("edit_message", { messageId, newText });
    socket.emit("delete_message", { messageId });
    socket.emit("delete_for_me", { messageId });
*/
//
// client/src/components/Chat/ChatNavBadge.tsx and the web useChat:
/*
    import { safeStorage } from "@/src/utils/safeStorage";

    const socket = io(SOCKET_URL, {
      withCredentials: true,
      auth: { token: safeStorage.get("accessToken") },
      transports: ["websocket", "polling"],
    });
*/
//
// And handle rejection, so a logged-out user sees something sensible
// rather than a silent dead socket:
/*
    socket.on("connect_error", (err) => {
      if (err.message === "UNAUTHORISED") {
        // Token expired. The axios interceptor will refresh on the next
        // request; reconnecting then will succeed.
        setConnected(false);
      }
    });
*/
//
// The token expires. When it does the socket drops and won't reconnect
// until a fresh one exists, so reconnect after a refresh:
/*
    // wherever the new token is stored
    socketRef.current?.disconnect();
    socketRef.current?.io.opts && (socketRef.current.io.opts.auth = { token: newToken });
    socketRef.current?.connect();
*/
