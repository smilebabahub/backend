import jwt from "jsonwebtoken";
const authMiddleware = (req, res, next) => {
  // middleware/authenticate.js
    // Header takes priority over cookie — the frontend always sends the
    // freshest token in the Authorization header via the request interceptor.
    // The cookie may still hold a stale token from a previous session.
    const headerToken = req.headers.authorization?.split(" ")[1];
    const cookieToken = req.cookies?.accessToken;
  
    const token = headerToken ?? cookieToken;
  
    if (!token) {
      return res.status(401).json({ message: "Not authenticated" });
    }
  
    try {
      const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
      req.user = decoded;
      next();
    } catch (err) {
      return res.status(401).json({ message: "Invalid or expired token" });
    }
  };
  


export default authMiddleware