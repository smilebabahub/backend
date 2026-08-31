// ═══════════════════════════════════════════════════════════════════════
// TOKEN REGISTRATION — controllers/pushController.js
// ═══════════════════════════════════════════════════════════════════════

import User from "../models/user.js";
import { Expo } from "expo-server-sdk";

// POST /auth/push-token   { token, platform, deviceId }
export const registerPushToken = async (req, res) => {
  try {
    const { token, platform, deviceId } = req.body;

    if (!token || !Expo.isExpoPushToken(token)) {
      return res.status(400).json({ message: "Invalid push token" });
    }

    // One row per token. Re-registering just refreshes lastUsedAt.
    await User.updateOne(
      { _id: req.user.userId },
      { $pull: { pushTokens: { token } } },
    );
    await User.updateOne(
      { _id: req.user.userId },
      {
        $push: {
          pushTokens: {
            token,
            platform,
            deviceId,
            lastUsedAt: new Date(),
          },
        },
      },
    );

    res.status(200).json({ message: "Push token registered" });
  } catch (err) {
    console.error("[registerPushToken]", err);
    res.status(500).json({ message: "Couldn't register for notifications" });
  }
};

// DELETE /auth/push-token   { token }
export const removePushToken = async (req, res) => {
  try {
    await User.updateOne(
      { _id: req.user.userId },
      { $pull: { pushTokens: { token: req.body.token } } },
    );
    res.status(200).json({ message: "Push token removed" });
  } catch (err) {
    res.status(500).json({ message: "Couldn't remove token" });
  }
};

// PATCH /auth/push-settings   { enabled }
export const setPushEnabled = async (req, res) => {
  try {
    await User.updateOne(
      { _id: req.user.userId },
      { $set: { pushEnabled: req.body.enabled !== false } },
    );
    res.status(200).json({ pushEnabled: req.body.enabled !== false });
  } catch (err) {
    res.status(500).json({ message: "Couldn't update settings" });
  }
};


// routes/authRoute.js — add:
//  
