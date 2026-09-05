// routes/supportRoute.js
import express from "express";
import {
  submitContact,
  requestAccountDeletion,
  confirmAccountDeletion,
} from "../controllers/supportController.js";

const router = express.Router();

// All three are public on purpose. The deletion page has to work signed
// out — that's a Google Play requirement — and someone locked out of
// their account is exactly who needs the contact form.
router.post("/contact", submitContact);
router.post("/deletion-request", requestAccountDeletion);
router.get("/deletion-request/confirm", confirmAccountDeletion);

export default router;

// ═══════════════════════════════════════════════════════════════════════
// server.js — THREE ADDITIONS
// ═══════════════════════════════════════════════════════════════════════
//
// 1. Mount the routes, alongside the others:
//
//      import supportRoutes from "./routes/supportRoute.js";
//      app.use("/smilebaba/support", supportRoutes);
//
//
// 2. Run the deletion worker daily. 4am is after the payout cron at 2am,
//    so they don't contend:
//
//      import { processDueDeletions } from "./controllers/supportController.js";
//
//      cron.schedule("0 4 * * *", () => {
//        processDueDeletions().catch((e) =>
//          console.error("[deletionCron]", e.message),
//        );
//      });
//









