import express from "express";
import authMiddleWare from '../middleware/authMiddleWare.js';
import {
  initializePayment,
  verifyPayment,
  flutterwaveWebhook,
} from "../controllers/paymentController.js";

const router = express.Router();

router.post("/initialize", authMiddleWare, initializePayment);

router.get("/verify", verifyPayment);

router.post("/webhook", flutterwaveWebhook);

export default router;
