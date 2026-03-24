// middleware/requireVendor.js
// Drop this on any route that needs vendor access (post listing, boost product)
// Works in both API routes and Next.js middleware

import User from "../models/user.js";

/**
 * Express middleware — blocks non-vendors and returns a 403 with a subscribeUrl
 * the frontend uses to redirect + encode the user's intended destination.
 *
 * Usage:
 *   router.post("/listings", authenticate, requireVendor, createListing)
 *   router.post("/listings/:id/boost", authenticate, requireVendor, boostListing)
 */
export const requireVendor = async (req, res, next) => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    // Re-fetch from DB so we always have the freshest role + expiry
    const user = await User.findById(userId).select("role subscription");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isVendor = user.role === "vendor";
    const isExpired =
      isVendor &&
      user.subscription?.expiresAt &&
      new Date(user.subscription.expiresAt) < new Date();

    if (!isVendor || isExpired) {
      // Tell the client WHY access was denied and WHERE to go
      return res.status(403).json({
        code: "SUBSCRIPTION_REQUIRED",
        message: isExpired
          ? "Your subscription has expired. Please renew to continue."
          : "A vendor subscription is required to perform this action.",
        // Frontend appends the current path as returnUrl before redirecting
        subscribeUrl: "/subscribe",
      });
    }

    next();
  } catch (error) {
    console.error("requireVendor error:", error);
    res.status(500).json({ message: "Authorization check failed" });
  }
};
