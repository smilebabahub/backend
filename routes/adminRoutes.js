// routes/adminRoutes.js
import express from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  getOverview,
  getUsers,
  getUserDetail,
  setUserRole,
  getSubscriptions,
  getMarketers,
  markMarketerPaidOut,
  getAds,
} from "../controllers/adminController.js";
import authMiddleware from "../middleware/authMiddleWare.js";

const router = express.Router();

// All admin routes require authentication + admin role
router.use(authMiddleware, requireAdmin);

// Dashboard overview
router.get("/overview", getOverview);

// Users
router.get("/users", getUsers);
router.get("/users/:id", getUserDetail);
router.patch("/users/:id/role", setUserRole);

// Subscriptions
router.get("/subscriptions", getSubscriptions);

// Marketers
router.get("/marketers", getMarketers);
router.patch("/marketers/:id/payout", markMarketerPaidOut);

// Ads
router.get("/ads", getAds);

export default router;
