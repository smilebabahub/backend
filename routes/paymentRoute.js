import express from "express";

import {
  initializePayment,
  verifyPayment,
  flutterwaveWebhook,
} from "../controllers/paymentController.js";

const router = express.Router();

router.post("/initialize", initializePayment);

router.get("/verify", verifyPayment);

router.post("/webhook", flutterwaveWebhook);

export default router;
