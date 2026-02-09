import express from "express";
import upload from "../middleware/uploadMiddleware.js";
import { createAd } from "../controllers/adController.js";

const router = express.Router();

router.post("/create", upload.array("images", 5), createAd);

export default router;
