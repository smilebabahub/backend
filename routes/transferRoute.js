// ═══════════════════════════════════════════════════════════════════════
// routes/transferRoute.js
// ═══════════════════════════════════════════════════════════════════════


import express from "express";
import authMiddleware from "../middleware/authMiddleWare.js";
import {
  recordTransfer, getMyTransfers, getTransfer,
} from "../controllers/transferController.js";

const router = express.Router();

router.post("/record", authMiddleware, recordTransfer);
router.get("/",        authMiddleware, getMyTransfers);
router.get("/:id",     authMiddleware, getTransfer);   // LAST

export default router;

