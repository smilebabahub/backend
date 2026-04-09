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

// Look up a marketer by their MongoDB _id — used by the subscription page
// to display the name of the marketer who referred this user on a free plan.
router.get("/referral/by-id/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const Marketer = (await import("../models/marketer.js")).default;
    const m = await Marketer.findById(id).select("name").lean();
    if (!m) return res.status(404).json({ message: "Marketer not found" });
    res.json({ name: m.name });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

// ── SSE: live stats for marketer dashboard ─────────────────────────────────
router.get("/stream", authenticateMarketer, marketerStatsSSE);

export default router;

// ── App update routes (separate file but exported here for convenience) ────
export const updatesRouter = express.Router();

// Handle CORS preflight — browsers send OPTIONS before EventSource connects
updatesRouter.options("/app", (req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
  }
  res.sendStatus(204);
});

// SSE stream — frontend connects once and listens for deploy events.
// IMPORTANT: 426 means Socket.IO's upgrade handler is racing this route.
// Ensure server.js mounts /smilebaba/updates BEFORE socket.io attaches.
updatesRouter.get("/app", appUpdatesSSE);

// Called by CI/CD on deploy
updatesRouter.post("/deploy", triggerDeploy);

// Also expose referral code check on payment routes for frontend
export { checkReferralCode };
