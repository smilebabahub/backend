import express from "express";
import { upload, processImages } from "../middleware/upload.middleware.js";
import protect from "../middleware/protect.js";

import {
  createProduct,
  getAllProducts,
  getSingleProduct,
  updateProduct,
  deleteProduct,
} from "../controllers/productController.js";
import subscribedOnly from "../middleware/subscriptionGuard.js";
import { vendorOnly } from "../middleware/roleGuard.js";
import Product from "../models/Product.js";

const router = express.Router();

// Everyone can view
router.get("/", getAllProducts);
router.get("/:id", getSingleProduct);

//CREATE (Any Logged-in User)

router.post(
  "/create",
  protect,
  upload.array("images", 5),
  processImages,
  createProduct,
);

// router.post(
//   "/products/create",
//   authMiddleware,
//   upload.array("images", 5),
//   processImages,
//   async (req, res) => {
//     const product = await Product.create({
//       ...req.body,
//       images: req.processedImages,
//       user: req.user.id,
//     });

//     res.status(201).json(product);
//   },
// );


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
