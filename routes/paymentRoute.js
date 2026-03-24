// routes/paymentRoutes.js
import express from "express";
import {
  initializePayment,
  verifyPayment,
  flutterwaveWebhook,
  getPurchaseHistory,
  getNotifications,
  markNotificationsRead,
} from "../controllers/paymentController.js";
import authMiddleware  from "../middleware/authMiddleWare.js";

const router = express.Router();

// Payment flow
router.post("/initialize", authMiddleware, initializePayment);
router.get("/verify", verifyPayment); // FLW redirect — no auth header (query params only)
router.post("/webhook", flutterwaveWebhook); // FLW webhook — verified via secret hash

// History & notifications
router.get("/history", authMiddleware, getPurchaseHistory);
router.get("/notifications", authMiddleware, getNotifications);
router.patch("/notifications/read", authMiddleware, markNotificationsRead);

export default router;
