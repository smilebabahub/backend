// middleware/requireAdmin.js
// Must be used AFTER authenticate middleware.
// Rejects requests from non-admin users.

export const requireAdmin = (req, res, next) => {
  const role = req.user?.role;
  const email = req.user?.email ?? "";

  const adminEmails = new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );

  const isAdmin = role === "admin" || adminEmails.has(email.toLowerCase());

  if (!isAdmin) {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
};
