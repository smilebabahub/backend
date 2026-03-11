import express from "express";
import upload from "../middleWare/uploadMiddleware.js";
import protect from "../middleWare/protect.js";

import {
  createProduct,
  getAllProducts,
  getSingleProduct,
  updateProduct,
  deleteProduct,
} from "../controllers/productController.js";

const router = express.Router();

// Everyone can view
router.get("/", getAllProducts);
router.get("/:id", getSingleProduct);

//CREATE (Any Logged-in User)

router.post("/create", protect, upload.array("images", 5), createProduct);

//UPDATE (Owner Vendor or Admin)
router.put("/:id", protect, upload.array("images", 5), updateProduct);

//DELETE (Owner Vendor or Admin)
router.delete("/:id", protect, deleteProduct);

router.get("/vendor/my-products", protect, vendorOnly, getAllProducts);

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
