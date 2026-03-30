// middleware/requireAdmin.js
// Must run AFTER authenticate middleware.
//
// Why we DB-lookup instead of reading req.user.role:
//   generateAccessToken only embeds { userId } in the JWT payload.
//   req.user only has { userId } after authenticate decodes it.
//   Role and email are NOT in the token — they live in the DB.
//   We fetch the user once and cache it on req.fullUser for downstream use.

import User from "../models/user.js";

const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export const requireAdmin = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const user = await User.findById(userId).select("email role").lean();
    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    const isAdmin =
      user.role === "admin" || ADMIN_EMAILS.has(user.email.toLowerCase());

    if (!isAdmin) {
      return res.status(403).json({ message: "Admin access required" });
    }

    // Attach full user so admin controllers can use it without another lookup
    req.adminUser = user;
    next();
  } catch (error) {
    console.error("requireAdmin error:", error);
    res.status(500).json({ message: "Auth check failed" });
  }
};
