
import express from "express";
import upload from "../middleWare/uploadMiddleware";
import auth from "../middleWare/authMiddleware"

import { createAd} from  "../controllers/adController";
import router from express.Router();


router.post("/create", auth, upload.array("images", 5), createAd);

export default router;
