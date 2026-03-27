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

const router = express.Router();

// ── Public routes ──────────────────────────────────────────────────────────
router.get("/", getAds); // GET /ads
router.get("/suggestions", getSearchSuggestions); // GET /ads/suggestions?q=
router.get("/slug/:slug", getAdBySlug); // GET /ads/slug/:slug

// ── Vendor-only — must come BEFORE /:id or Express reads "my" as the id ───
router.get("/my", authMiddleware, requireVendor, getMyAds); // GET    /ads/my
router.post("/", authMiddleware, requireVendor, createAd); // POST   /ads
router.post("/:id/boost", authMiddleware, requireVendor, boostAd); // POST   /ads/:id/boost
router.patch("/:id/sold", authMiddleware, requireVendor, markAsSold); // PATCH  /ads/:id/sold
router.patch("/:id/pause", authMiddleware, requireVendor, togglePause); // PATCH  /ads/:id/pause

// ── Dynamic :id routes ─────────────────────────────────────────────────────
router.get("/:id", getAdById); // GET    /ads/:id
router.patch("/:id", authMiddleware, updateAd); // PATCH  /ads/:id
router.delete("/:id", authMiddleware, deleteAd); // DELETE /ads/:id

// ── Authenticated (any logged-in user) ─────────────────────────────────────
router.post("/:id/contact-click", authMiddleware, recordContactClick); // POST /ads/:id/contact-click

// ── Admin only ─────────────────────────────────────────────────────────────
router.patch("/:id/moderate", authMiddleware, moderateAd); // PATCH /ads/:id/moderate

export default router;
