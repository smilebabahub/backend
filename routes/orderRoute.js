// routes/orderRoute.js
import express from "express";
import authMiddleware from "../middleware/authMiddleWare.js";
import { requireVendor } from "../middleware/requireVendo.js";
import {
  getMyOrders,
  getVendorOrders,
  createOrder,
  updateOrderStatus,
} from "../controllers/orderController.js";

const router = express.Router();

router.get("/my",            authMiddleware,              getMyOrders);
router.get("/vendor",        authMiddleware, requireVendor, getVendorOrders);
router.post("/",             authMiddleware,              createOrder);
router.patch("/:id/status",  authMiddleware, requireVendor, updateOrderStatus);

export default router;
