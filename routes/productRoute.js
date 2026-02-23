import express from "express";
import upload from "../middleWare/uploadMiddleware.js";
import protect from "../middleWare/protect.js";
import subscribedOnly from "../middleWare/subscriptionGuard.js";
import { vendorOnly } from "../middleWare/roleGuard.js";
import { createProduct } from "../controllers/productController.js";

const router = express.Router();

// so this is where we insist on strictness. subscribed vendors only
router.post(
  "/create",
  protect,
  vendorOnly,
  subscribedOnly,
  upload.array("images", 5),
  createProduct,
);

export default router;
