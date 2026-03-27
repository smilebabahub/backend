// routes/productRoutes.js
// Matches frontend calls from productsActions.ts:
//   GET  /products          → fetchProducts (public feed)
//   GET  /products/my       → fetchMyProducts (vendor)
//   GET  /products/:id      → fetchProductById
//   DELETE /products/:id    → deleteProduct (owner/admin)
//

import express from "express";
import { requireVendor } from "../middleware/requireVendo.js";

// ── Controller — replace these with your actual product controller ─────────
// If your products are handled by a different model (Listing, Product, etc.)
// point these imports at that controller file.
import {
  getProducts,
  getProductById,
  getMyProducts,
  deleteProductById,
} from "../controllers/productController.js";
import authMiddleware from "../middleware/authMiddleWare.js";

const router = express.Router();

// ── IMPORTANT: static paths must come BEFORE dynamic :id ───────────────────
router.get("/my", authMiddleware, requireVendor, getMyProducts); // GET /products/my
router.get("/", getProducts); // GET /products
router.get("/:id", getProductById); // GET /products/:id
router.delete("/:id", authMiddleware, deleteProductById); // DELETE /products/:id

export default router;
