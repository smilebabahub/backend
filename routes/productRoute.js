import express from "express";
import upload from "../middleware/uploadMiddleware.js";
import protect from "../middleware/protect.js";
import subscribedOnly from "../middleware/subscribedOnly.js";
import { vendorOnly } from "../middleware/roleGuard.js";
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
