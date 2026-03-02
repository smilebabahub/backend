import express from "express";
import Message from "../models/Message.js";

const router = express.Router();

router.get("/:room", async (req, res) => {
  try {
    const messages = await Message.find({ room: req.params.room }).sort({
      createdAt: 1,
    });

    res.status(200).json(messages);
  } catch (error) {
    res.status(500).json({ msg: "Failed to fetch messages" });
  }
});

export default router;
