import express from "express";
import upload from "../middleware/uploadMiddleware.js";
import protect from "../middleware/protect.js";
import subscribedOnly from "../middleware/subscriptionGuard.js";
import { vendorOnly } from "../middleware/roleGuard.js";

import {
  createProduct,
  getProducts,
  getProduct,
  updateProduct,
  deleteProduct,
} from "../controllers/productController.js";

const router = express.Router();

// so same as the add products, all users regardless can access all products, no authentication required to get this bro
router.get("/", getProducts);
router.get("/:id", getProduct);

// strict authorization here
router.post(
  "/create",
  protect,
  vendorOnly,
  subscribedOnly,
  upload.array("images", 5),
  createProduct,
);

//router.get("/vendor/my-products", protect, vendorOnly, getVendorProducts);

router.patch(
  "/:id",
  protect,
  vendorOnly,
  subscribedOnly,
  upload.array("images", 5),
  updateProduct,
);

router.delete("/:id", protect, vendorOnly, subscribedOnly, deleteProduct);

export default router;
