// routes/adBoostPaymentRoutes.js
import express from "express";
import {
  initializeBoostPayment,
  verifyBoostPayment,
  boostPaymentWebhook,
  getBoostPricing,
} from "../controllers/adBoostPaymentController.js";
import { requireVendor } from "../middleware/requireVendo.js";
import { withCountry } from "./paymentRoute.js"; // reuse existing country middleware
import authMiddleware from "../middleware/authMiddleWare.js";

const router = express.Router();

// ── Public ──────────────────────────────────────────────────────────────────
// Returns boost tier pricing for the given currency
// GET /payments/boost/pricing?currency=GHS
router.get("/pricing", getBoostPricing);

// ── Country-aware routes ─────────────────────────────────────────────────────
// Inject req.countryCode and req.gatewayCurrency based on URL prefix

// Ghana
router.post(
  "/gh/initialize",
  withCountry("GH"),
  authMiddleware,
  requireVendor,
  initializeBoostPayment,
);
router.get("/gh/verify", withCountry("GH"), authMiddleware, verifyBoostPayment);
router.post("/gh/webhook", withCountry("GH"), boostPaymentWebhook);

// Nigeria
router.post(
  "/ng/initialize",
  withCountry("NG"),
  authMiddleware,
  requireVendor,
  initializeBoostPayment,
);
router.get("/ng/verify", withCountry("NG"), authMiddleware, verifyBoostPayment);
router.post("/ng/webhook", withCountry("NG"), boostPaymentWebhook);

// International fallback
router.post(
  "/intl/initialize",
  withCountry("INTL"),
  authMiddleware,
  requireVendor,
  initializeBoostPayment,
);
router.get(
  "/intl/verify",
  withCountry("INTL"),
  authMiddleware,
  verifyBoostPayment,
);
router.post("/intl/webhook", withCountry("INTL"), boostPaymentWebhook);

export default router;
