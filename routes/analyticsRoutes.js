// routes/analyticsRoutes.js
// Public page-view tracker only.
// Admin analytics endpoints live in adminRoutes.js at /admin/analytics/*
import express from "express";
import jwt from "jsonwebtoken";
import { trackPageView } from "../controllers/analyticsController.js";

const router = express.Router();

// Optional auth — captures userId for logged-in users, never blocks guests
function optionalAuth(req, res, next) {
  const token =
    req.headers.authorization?.split(" ")[1] || req.cookies?.accessToken;
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
    } catch {
      /* expired/invalid — treat as guest */
    }
  }
  next();
}

// POST /smilebaba/analytics — called by AnalyticsTracker on every page load
router.post("/", optionalAuth, trackPageView);

export default router;
