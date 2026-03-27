// routes/paymentRoutes.js
import express from "express";
import {
  initializePayment,
  verifyPayment,
  paymentWebhook,
  getPurchaseHistory,
  getNotifications,
  markNotificationsRead,
} from "../controllers/paymentController.js";
import authMiddleware from "../middleware/authMiddleWare.js";

const router = express.Router();

// ── Country middleware factory ─────────────────────────────────────────────
// Injects req.countryCode + req.gatewayCurrency so the controller
// never needs to parse the URL itself
const CURRENCY_MAP = { gh: "GHS", ng: "NGN", intl: "USD" };

export function withCountry(code) {
  return (req, _res, next) => {
    req.countryCode = code.toUpperCase();
    req.gatewayCurrency = CURRENCY_MAP[code.toLowerCase()] ?? "USD";
    next();
  };
}

// ── Ghana (/payments/gh/*) ─────────────────────────────────────────────────
router.post(
  "/gh/initialize",
  authMiddleware,
  withCountry("gh"),
  initializePayment,
);
router.get("/gh/verify", withCountry("gh"), verifyPayment);
router.post("/gh/webhook", withCountry("gh"), paymentWebhook);

// ── Nigeria (/payments/ng/*) ───────────────────────────────────────────────
router.post(
  "/ng/initialize",
  authMiddleware,
  withCountry("ng"),
  initializePayment,
);
router.get("/ng/verify", withCountry("ng"), verifyPayment);
router.post("/ng/webhook", withCountry("ng"), paymentWebhook);

// ── International (/payments/intl/*) ──────────────────────────────────────
router.post(
  "/intl/initialize",
  authMiddleware,
  withCountry("intl"),
  initializePayment,
);
router.get("/intl/verify", withCountry("intl"), verifyPayment);
router.post("/intl/webhook", withCountry("intl"), paymentWebhook);

// ── Shared (no country prefix) ─────────────────────────────────────────────
router.get("/history", authMiddleware, getPurchaseHistory);
router.get("/notifications", authMiddleware, getNotifications);
router.patch("/notifications/read", authMiddleware, markNotificationsRead);

export default router;
