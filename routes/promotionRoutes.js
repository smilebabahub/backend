// routes/promotionRoutes.js
// Mount in server.js:
//   app.use("/smilebaba", promotionRoutes);

import { Router } from "express";
import { authenticate } from "../middleware/authMiddleWare.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  getPromoPricing,
  submitPromotion,
  getMyPromotions,
  initializePromoPayment,
  verifyPromoPayment,
  getAdminPromotions,
  updateAdminPromotion,
} from "../controllers/promotionController.js";
import { getPromoStats } from "../controllers/promoStatsController.js";

const router = Router();

// ── Public ────────────────────────────────────────────────────────────────
router.get("/promote/pricing", getPromoPricing);
router.get("/promote/stats", getPromoStats); // public live stats for /promote hero
router.get("/promote/verify", verifyPromoPayment); // FLW redirect target

// ── Authenticated ─────────────────────────────────────────────────────────
router.post("/promote/submit", authenticate, submitPromotion);
router.get("/promote/my", authenticate, getMyPromotions);
router.post("/promote/:id/pay", authenticate, initializePromoPayment);

// ── Admin ─────────────────────────────────────────────────────────────────
router.get("/admin/promotions", authenticate, requireAdmin, getAdminPromotions);
router.patch(
  "/admin/promotions/:id",
  authenticate,
  requireAdmin,
  updateAdminPromotion,
);

export default router;
