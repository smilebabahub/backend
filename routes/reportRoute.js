// routes/reportRoute.js
import express from "express";
import authMiddleware from "../middleware/authMiddleWare.js";
import optionalAuth from "../middleware/optionalAuth.js";
import {
  submitReport,
  getReports,
  getAdReports,
  resolveReport,
} from "../controllers/reportController.js";

const router = express.Router();

// Public. Requiring an account to report a scam is how scams stay up —
// optionalAuth attaches req.user when there's a token and moves on when
// there isn't, so a signed-in report still gets attributed.
router.post("/", optionalAuth, submitReport);

// Admin
router.get("/", authMiddleware, getReports);
router.get("/ad/:adId", authMiddleware, getAdReports);
router.patch("/:id/resolve", authMiddleware, resolveReport);

export default router;





// ═══════════════════════════════════════════════════════════════════════
// HOW AUTO-HIDE BEHAVES
//
// Reports are scored by distinct reporter, weighted by reason:
//
//     scam · counterfeit · prohibited     1.5
//     offensive                           1.2
//     misleading · other                  1.0
//     duplicate · sold                    0.5
//
// A listing hides at a total of 3.0. So:
//
//     two scam reports        3.0  → hidden
//     three misleading        3.0  → hidden
//     six "already sold"      3.0  → hidden
//     one person, five times  1.5  → not hidden
//
// That last one is the unique index doing its job.
//
// Hidden means `isPaused: true`, not deleted. An admin resolving
// "no_action" brings it straight back and clears the other open reports
// against it, so the queue doesn't ask twice.
//
// Tune AUTO_HIDE_THRESHOLD and REASON_WEIGHT in models/reportModel.js.
// If competitors start abusing it, raise the threshold rather than
// removing the feature — the alternative is scams running overnight.
// ═══════════════════════════════════════════════════════════════════════
