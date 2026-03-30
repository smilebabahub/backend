// routes/chatRoute.js
import express from "express";
import authMiddleware from "../middleware/authMiddleWare.js";
import {
  getOrCreateRoom,
  getConversations,
  getRoomMessages,
  deleteConversation,
  getUnreadCount,
} from "../controllers/chatController.js";

const router = express.Router();

// All chat routes require authentication
router.use(authMiddleware);

// GET /chat/conversations       — list all conversations with last message + unread count
router.get("/conversations", getConversations);

// GET /chat/unread               — total unread count badge
router.get("/unread", getUnreadCount);

// GET /chat/room/:otherUserId    — get or create room, returns room id + messages
router.get("/room/:otherUserId", getOrCreateRoom);

// GET /chat/messages/:room       — paginated older messages (cursor-based)
router.get("/messages/:room", getRoomMessages);

// DELETE /chat/conversation/:room — soft-delete all messages in a room for self
router.delete("/conversation/:room", deleteConversation);

export default router;
