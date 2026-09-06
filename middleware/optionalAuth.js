// ═══════════════════════════════════════════════════════════════════════
// middleware/optionalAuth.js  — NEW, if you don't have one
//
// Same as authMiddleware but never rejects. A guest reporting a scam
// shouldn't hit a 401.
// ═══════════════════════════════════════════════════════════════════════

import jwt from "jsonwebtoken";

export default function optionalAuth(req, _res, next) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) return next();

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    // An expired token on a public route is not an error — treat them
    // as a guest and carry on.
  }
  next();
}