// routes/authRoutes.js
import express from "express";
import rateLimit from "express-rate-limit";
import { ipKeyGenerator } from "express-rate-limit";
import {
  register,
  login,
  getCurrentUser,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  getGuestCountry,
  adminSwitchCountry,
  updateProfile,
  changePassword,
  updateNotifications,
  updatePaymentDetails,
  updateShipping,
  submitPromotion,
  resendOTP,
  verifyOTP,
} from "../controllers/authController.js";
import { authenticate } from "../middleware/authMiddleWare.js";

const router = express.Router();

// ── IP resolver (inlined — no separate file) ──────────────────────────────
function resolveClientIP(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf) return cf.trim();
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

// ── Tight rate limiters for sensitive auth endpoints ──────────────────────
// Login / register: 10 attempts per 15 min per IP — prevents brute force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { message: "Too many attempts. Please try again in 15 minutes." },
  keyGenerator: (req) => {
    const ip = resolveClientIP(req) || req.ip || "127.0.0.1";
    try {
      return ipKeyGenerator(ip);
    } catch {
      return ip;
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Password reset: 5 per hour — prevents email flooding
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: {
    message: "Too many password reset requests. Try again in 1 hour.",
  },
  keyGenerator: (req) => {
    const ip = resolveClientIP(req) || req.ip || "127.0.0.1";
    try {
      return ipKeyGenerator(ip);
    } catch {
      return ip;
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Token refresh: 60 per 15 min — legitimate apps refresh frequently
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  keyGenerator: (req) => {
    const ip = resolveClientIP(req) || req.ip || "127.0.0.1";
    try {
      return ipKeyGenerator(ip);
    } catch {
      return ip;
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Public ────────────────────────────────────────────────────────────────
router.post("/register", authLimiter, register);
router.post("/login", authLimiter, login);
router.post("/refresh", refreshLimiter, refresh);
router.post("/forgot-password", resetLimiter, forgotPassword);
router.post("/reset-password", resetLimiter, resetPassword);

// ── Phone OTP verification (optional — post-registration phone verify) ────
// Tight rate limit: 5 OTP sends per 15 min to prevent SMS flooding
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { message: "Too many OTP requests. Try again in 15 minutes." },
  keyGenerator: (req) => {
    const ip = resolveClientIP(req) || req.ip || "127.0.0.1";
    try {
      return ipKeyGenerator(ip);
    } catch {
      return ip;
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/resend-otp", otpLimiter, resendOTP);
router.post("/verify-otp", otpLimiter, verifyOTP);

// Guest country detection — low impact, no sensitive data
router.get("/guest-country", getGuestCountry);

// ── Protected ─────────────────────────────────────────────────────────────
router.get("/me", authenticate, getCurrentUser);
router.post("/logout", authenticate, logout);
router.patch("/admin/country", authenticate, adminSwitchCountry);

// ── Vendor settings ────────────────────────────────────────────────────────
router.patch("/profile", authenticate, updateProfile);
router.patch("/password", authenticate, changePassword);
router.patch("/notifications", authenticate, updateNotifications);
router.patch("/payment-details", authenticate, updatePaymentDetails);
router.patch("/shipping", authenticate, updateShipping);
router.post("/promotion", authenticate, submitPromotion);

export default router;
