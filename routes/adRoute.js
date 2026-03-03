import express from "express";
import upload from "../middleware/uploadMiddleware.js";
import protect from "../middleware/protect.js";

import {
  createAd,
  getAds,
  getSingleAd,
  updateAd,
  deleteAd,
} from "../controllers/adController.js";

// const router = express.Router();

// Yoo, a user does not need authentication to be able to see the various adds posted, so we take of the protection here, okay
router.get("/", getAds);
router.get("/:id", getSingleAd);

// so all this routes are protected under the authentication
router.post("/create", protect, upload.array("images", 5), createAd);
router.put("/:id", protect, upload.array("images", 5), updateAd);
router.delete("/:id", protect, deleteAd);

// export default router;
