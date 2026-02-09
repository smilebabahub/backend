import express from "express";
import auth from "../middleware/auth.js";
import {
  initializePayment,
  verifyPayment,
  flutterwaveWebhook,
} from "../controllers/paymentController.js";

const router = express.Router();

router.post("/initialize", auth, initializePayment);

router.get("/verify", verifyPayment);

router.post("/webhook", flutterwaveWebhook);

export default router;
