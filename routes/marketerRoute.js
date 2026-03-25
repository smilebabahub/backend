// routes/marketerRoutes.js
import express from "express";
import {
  registerMarketer,
  loginMarketer,
  getMarketerDashboard,
  validateReferralCode,
  updatePayoutDetails,
} from "../controllers/marketerController.js";
import { checkReferralCode } from "../controllers/paymentController.js";
import {
  appUpdatesSSE,
  marketerStatsSSE,
  triggerDeploy,
} from "../controllers/updatesController.js";
import jwt from "jsonwebtoken";

// ── Marketer auth middleware ───────────────────────────────────────────────
const authenticateMarketer = (req, res, next) => {
  const headerToken = req.headers.authorization?.split(" ")[1];
  const cookieToken = req.cookies?.marketerAccessToken;
  const token = headerToken ?? cookieToken;

  if (!token) return res.status(401).json({ message: "Not authenticated" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    if (decoded.role !== "marketer")
      return res.status(403).json({ message: "Not a marketer account" });
    req.marketer = decoded;
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired token" });
  }
};

const router = express.Router();

// ── Auth ───────────────────────────────────────────────────────────────────
router.post("/register", registerMarketer);
router.post("/login", loginMarketer);

// ── Dashboard ──────────────────────────────────────────────────────────────
router.get("/dashboard", authenticateMarketer, getMarketerDashboard);
router.patch("/payout", authenticateMarketer, updatePayoutDetails);

// ── Referral code validation (public — vendors call this) ──────────────────
router.get("/referral/:code/validate", validateReferralCode);

// ── SSE: live stats for marketer dashboard ─────────────────────────────────
router.get("/stream", authenticateMarketer, marketerStatsSSE);

export default router;

// ── App update routes (separate file but exported here for convenience) ────
export const updatesRouter = express.Router();

// SSE stream — frontend connects once and listens for deploy events
updatesRouter.get("/app", appUpdatesSSE);

// Called by CI/CD on deploy
updatesRouter.post("/deploy", triggerDeploy);

// Also expose referral code check on payment routes for frontend
export { checkReferralCode };
