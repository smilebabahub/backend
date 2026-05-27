// routes/newsRoutes.js
// Public news read + admin write.
// Mount in server.js:  app.use("/smilebaba", newsRoutes);

import { Router } from "express";
import { authenticate } from "../middleware/authMiddleWare.js";
import { requireAdmin } from "../middleware/requireAdmin.js"; // see note below
import {
  getNews,
  getNewsBySlug,
  getNewsTicker,
  createNews,
  updateNews,
  deleteNews,
  getAdminNewsList,
} from "../controllers/newsController.js";

const router = Router();

// ── Public ────────────────────────────────────────────────────────────────
router.get("/news", getNews);
router.get("/news/ticker", getNewsTicker);
router.get("/news/:slug", getNewsBySlug);

// ── Admin ─────────────────────────────────────────────────────────────────
router.get("/admin/news", authenticate, requireAdmin, getAdminNewsList);
router.post("/admin/news", authenticate, requireAdmin, createNews);
router.patch("/admin/news/:id", authenticate, requireAdmin, updateNews);
router.delete("/admin/news/:id", authenticate, requireAdmin, deleteNews);

export default router;

/* Note on requireAdmin:
 * If you don't have this middleware yet, create middleware/requireAdmin.js:
 *
 *   export function requireAdmin(req, res, next) {
 *     if (req.user?.role !== "admin") {
 *       return res.status(403).json({ message: "Admin access required" });
 *     }
 *     next();
 *   }
 */
