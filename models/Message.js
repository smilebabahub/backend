import mongoose from "mongoose";

const messageSchema = new mongoose.Schema(
  {
    room: {
      type: String,
      required: true,
    },
    sender: {
      type: String,
      required: true,
    },
    receiver: {
      type: String,
      required: true,
    },
    text: {
      type: String,
      required: true,
    },

    // NEW FEATURES
    edited: {
      type: Boolean,
      default: false,
    },

    deleted: {
      type: Boolean,
      default: false,
    },

    deletedFor: [
      {
        type: String, // userId
      },
    ],
  },
  { timestamps: true },
);

export default mongoose.model("Message", messageSchema);
