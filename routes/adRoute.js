// routes/adRoutes.js
import express from "express";
import {
  createAd,
  getAds,
  getAdById,
  getAdBySlug,
  updateAd,
  deleteAd,
  boostAd,
  markAsSold,
  togglePause,
  recordContactClick,
  getMyAds,
  moderateAd,
  getSearchSuggestions,
} from "../controllers/adController.js";
import { requireVendor } from "../middleware/requireVendo.js";
import authMiddleware from "../middleware/authMiddleWare.js";

const adRoute = express.Router();

// ── Public routes ──────────────────────────────────────────────────────────
adRoute.get("/", getAds); // GET  /ads
adRoute.get("/suggestions", getSearchSuggestions); // GET  /ads/suggestions?q=
adRoute.get("/slug/:slug", getAdBySlug); // GET  /ads/slug/:slug
adRoute.get("/:id", getAdById); // GET  /ads/:id

// ── Authenticated routes (any logged-in user) ──────────────────────────────
adRoute.post("/:id/contact-click", authMiddleware, recordContactClick); // POST /ads/:id/contact-click

// ── Vendor-only routes ─────────────────────────────────────────────────────
adRoute.get("/my", authMiddleware, requireVendor, getMyAds); // GET   /ads/my
adRoute.post("/", authMiddleware, requireVendor, createAd); // POST  /ads
adRoute.patch("/:id", authMiddleware, updateAd); // PATCH /ads/:id  (owner or admin)
adRoute.delete("/:id", authMiddleware, deleteAd); // DELETE /ads/:id (owner or admin)
adRoute.post("/:id/boost", authMiddleware, requireVendor, boostAd); // POST  /ads/:id/boost
adRoute.patch("/:id/sold", authMiddleware, requireVendor, markAsSold); // PATCH /ads/:id/sold
adRoute.patch("/:id/pause", authMiddleware, requireVendor, togglePause); // PATCH /ads/:id/pause

// ── Admin-only routes ──────────────────────────────────────────────────────
adRoute.patch("/:id/moderate", authMiddleware, moderateAd); // PATCH /ads/:id/moderate

export default adRoute;
