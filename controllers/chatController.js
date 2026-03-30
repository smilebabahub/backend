// controllers/chatController.js
// REST handlers for chat history, room lookup, and unread counts.
// Real-time messaging is handled separately in socketHandler.js.

import Message from "../models/chatModel.js";
import mongoose from "mongoose";

// ── Deterministic room name for two users ─────────────────────────────────────
// Always produces the same string regardless of which user calls first.
export function buildRoomId(userAId, userBId) {
  const ids = [String(userAId), String(userBId)].sort();
  return `room_${ids[0]}_${ids[1]}`;
}

// ── GET /chat/room/:otherUserId ───────────────────────────────────────────────
// Returns or creates a room ID for the two users, plus the last 50 messages.
export const getOrCreateRoom = async (req, res) => {
  try {
    const myId      = String(req.user.userId);
    const otherId   = String(req.params.otherUserId);

    if (myId === otherId) {
      return res.status(400).json({ message: "Cannot chat with yourself" });
    }

    const room = buildRoomId(myId, otherId);

    // Fetch recent messages (newest first, then reverse for display)
    const messages = await Message
      .find({
        room,
        deletedFor: { $ne: myId },   // exclude messages I deleted for myself
        deleted:    false,
      })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate("sender",   "username profilePicture")
      .populate("receiver", "username profilePicture")
      .lean();

    // Mark unread messages (sent by other user) as read
    await Message.updateMany(
      { room, receiver: myId, readBy: { $ne: myId } },
      { $addToSet: { readBy: myId } }
    );

    res.status(200).json({
      room,
      messages: messages.reverse(),
    });
  } catch (error) {
    console.error("getOrCreateRoom error:", error);
    res.status(500).json({ message: "Failed to load chat" });
  }
};

// ── GET /chat/conversations ───────────────────────────────────────────────────
// Returns a list of all conversations for the current user,
// with the last message and unread count for each.
export const getConversations = async (req, res) => {
  try {
    const myId = String(req.user.userId);

    // Get the latest message from each room this user participates in
    const conversations = await Message.aggregate([
      {
        $match: {
          $or: [{ sender: new mongoose.Types.ObjectId(myId) }, { receiver: new mongoose.Types.ObjectId(myId) }],
          deleted:    false,
          deletedFor: { $ne: myId },
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id:         "$room",
          lastMessage: { $first: "$$ROOT" },
          unread: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: [{ $toString: "$receiver" }, myId] },
                    { $not: { $in: [myId, "$readBy"] } },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      { $sort: { "lastMessage.createdAt": -1 } },
      { $limit: 30 },
    ]);

    // Populate sender/receiver on the last message
    await Message.populate(conversations, [
      { path: "lastMessage.sender",   select: "username profilePicture", model: "User" },
      { path: "lastMessage.receiver", select: "username profilePicture", model: "User" },
    ]);

    res.status(200).json({ conversations });
  } catch (error) {
    console.error("getConversations error:", error);
    res.status(500).json({ message: "Failed to load conversations" });
  }
};

// ── GET /chat/messages/:room ──────────────────────────────────────────────────
// Paginated message history for a room (cursor-based).
export const getRoomMessages = async (req, res) => {
  try {
    const myId    = String(req.user.userId);
    const { room } = req.params;
    const before  = req.query.before;   // ISO timestamp cursor
    const limit   = Math.min(Number(req.query.limit ?? 30), 100);

    const filter = {
      room,
      deletedFor: { $ne: myId },
      deleted:    false,
    };
    if (before) filter.createdAt = { $lt: new Date(before) };

    const messages = await Message
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("sender",   "username profilePicture")
      .populate("receiver", "username profilePicture")
      .lean();

    res.status(200).json({
      messages:  messages.reverse(),
      hasMore:   messages.length === limit,
    });
  } catch (error) {
    console.error("getRoomMessages error:", error);
    res.status(500).json({ message: "Failed to load messages" });
  }
};

// ── DELETE /chat/conversation/:room ──────────────────────────────────────────
// Soft-deletes all messages in a room FOR THE CURRENT USER ONLY.
export const deleteConversation = async (req, res) => {
  try {
    const myId = String(req.user.userId);
    await Message.updateMany(
      { room: req.params.room },
      { $addToSet: { deletedFor: myId } }
    );
    res.status(200).json({ message: "Conversation cleared" });
  } catch (error) {
    console.error("deleteConversation error:", error);
    res.status(500).json({ message: "Failed to delete conversation" });
  }
};

// ── GET /chat/unread ──────────────────────────────────────────────────────────
// Total unread message count across all conversations.
export const getUnreadCount = async (req, res) => {
  try {
    const myId  = String(req.user.userId);
    const count = await Message.countDocuments({
      receiver:   new mongoose.Types.ObjectId(myId),
      readBy:     { $ne: myId },
      deleted:    false,
      deletedFor: { $ne: myId },
    });
    res.status(200).json({ unread: count });
  } catch (error) {
    res.status(500).json({ message: "Failed to get unread count" });
  }
};