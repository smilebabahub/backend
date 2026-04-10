// middleware/authenticate.js
import jwt from "jsonwebtoken";

// Reads JWT from three locations in priority order:
//   1. Authorization: Bearer <token>  — standard, used by axios interceptor
//   2. Cookie accessToken             — set on login for browser sessions
//   3. ?token= query param            — SSE / EventSource (can't set headers)
//
// ?token= is only accepted on GET requests so it can't be used on mutations.
// req.user.userId is always normalised from either userId, id, or _id.

const authMiddleware = (req, res, next) => {
  const headerToken = req.headers.authorization?.split(" ")[1];
  const cookieToken = req.cookies?.accessToken;
  const queryToken = req.method === "GET" ? req.query.token : undefined;

  const token = headerToken ?? cookieToken ?? queryToken;

  if (!token) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    req.user = {
      ...decoded,
      userId: decoded.userId ?? decoded.id ?? decoded._id,
    };
    next();
  } catch (err) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};

export default authMiddleware;
export { authMiddleware as authenticate };
