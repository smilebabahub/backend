// routes/orderRoute.js
import express from "express";
import authMiddleware from "../middleware/authMiddleWare.js";
import { requireVendor } from "../middleware/requireVendo.js";
import { withCountry } from "./paymentRoute.js"; // reuse country factory
import {
  // list & detail
  getMyOrders,
  getVendorOrders,
  getSingleOrder,
  // buy flow
  createOrder,
  initOrderPayment,
  verifyOrderPayment,
  orderPaymentWebhook,
  // lifecycle
  updateOrderStatus,
  confirmDelivery,
  requestRefund,
  reportDispute,
  getOrderGroup,
} from "../controllers/orderController.js";

const router = express.Router();

// ── List & detail ─────────────────────────────────────────────────────
router.get("/my", authMiddleware, getMyOrders);
router.get("/mine", authMiddleware, getMyOrders); // mobile alias
router.get("/vendor", authMiddleware, requireVendor, getVendorOrders);

// ── Create + pay ──────────────────────────────────────────────────────
router.post("/", authMiddleware, createOrder);
router.post("/:id/pay", authMiddleware, initOrderPayment);
router.post("/verify", authMiddleware, verifyOrderPayment);

// ── Flutterwave webhooks (raw body registered in server.js) ───────────
router.post("/webhook", withCountry("gh"), orderPaymentWebhook);
router.post("/gh/webhook", withCountry("gh"), orderPaymentWebhook);
router.post("/ng/webhook", withCountry("ng"), orderPaymentWebhook);
router.post("/intl/webhook", withCountry("intl"), orderPaymentWebhook);

// ── Lifecycle actions ─────────────────────────────────────────────────
router.patch("/:id/status", authMiddleware, requireVendor, updateOrderStatus);
router.post("/:id/confirm-delivery", authMiddleware, confirmDelivery);
router.post("/:id/refund", authMiddleware, requestRefund);
router.post("/:id/dispute", authMiddleware, reportDispute);

router.post("/group/:groupId/pay", authMiddleware, initOrderPayment);
router.get("/group/:groupId", authMiddleware, getOrderGroup);

// ── Single order — LAST so /my /mine /vendor aren't matched by /:id ──
router.get("/:id", authMiddleware, getSingleOrder);

export default router;
