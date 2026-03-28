import express from "express";
import {
  register,
  login,
  logout,
  refresh,
  forgotPassword,
  resetPassword,
  getCurrentUser,
  getGuestCountry,
} from "../controllers/authController.js";
import authMiddleware from "../middleware/authMiddleWare.js";

const router = express.Router();

router.post("/register", register);
router.post("/login", login);
router.post("/logout", logout);
router.post("/refresh", refresh);
router.get("/me", authMiddleware, getCurrentUser);

// Guest country detection — no auth, called on app mount for unauthenticated visitors
router.get("/guest-country",      getGuestCountry);

router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

export default router;
