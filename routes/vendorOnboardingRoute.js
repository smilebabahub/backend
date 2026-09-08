// routes/vendorOnboardingRoute.js
import express from "express";
import { authenticate } from "../middleware/authMiddleWare.js";
import {
  getMyOnboarding,
  saveStep,
  completeOnboarding,
  getVendorList,
  suspendVendor,
} from "../controllers/vendorOnboardingController.js";

const router = express.Router();

router.get("/me", authenticate, getMyOnboarding);
router.patch("/step/:step", authenticate, saveStep);
router.post("/complete", authenticate, completeOnboarding);

// Admin
router.get("/vendors", authenticate, getVendorList);
router.patch("/:id/suspend", authenticate, suspendVendor);

export default router;
