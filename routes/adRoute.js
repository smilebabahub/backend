
import express from "express";
import upload from "../middleWare/uploadMiddleware.js";
import auth from "../middleWare/authMiddleware.js"

import { createAd} from  "../controllers/adController.js";
const router =  express.Router();


router.post("/create", auth, upload.array("images", 5), createAd);

export default router;
