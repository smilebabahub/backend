// routes/orderRoutes.js
import express from "express";
import { requireVendor } from "../middleware/requireVendo.js";
import {
  getMyOrders,
  createOrder,
  updateOrderStatus,
} from "../controllers/orderController.js";
import authMiddleware from "../middleware/authMiddleWare.js";

const router = express.Router();

router.get("/my", authMiddleware, getMyOrders);
router.post("/", authMiddleware, createOrder);
router.patch("/:id/status", authMiddleware, requireVendor, updateOrderStatus);

export default router;
