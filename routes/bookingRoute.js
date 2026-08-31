// routes/bookingRoute.js
import express from "express";
import authMiddleware from "../middleware/authMiddleWare.js";
import { requireVendor } from "../middleware/requireVendo.js";
import {
  getMyBookings,
  getVendorBookings,
  getSingleBooking,
  getAvailability,
  createBooking,
  initBookingPayment,
  verifyBookingPayment,
  bookingWebhook,
  updateBookingStatus,
  confirmCheckIn,
  cancelBooking,
} from "../controllers/bookingController.js";

const router = express.Router();

// ── Public ───────────────────────────────────────────────────────────
// The calendar needs this before anyone signs in, so a guest can see
// what's free without an account.
router.get("/availability/:adId", getAvailability);

// ── Flutterwave webhook (raw body registered in server.js) ───────────
router.post("/webhook", bookingWebhook);

// ── Lists ────────────────────────────────────────────────────────────
router.get("/my", authMiddleware, getMyBookings);
router.get("/vendor", authMiddleware, requireVendor, getVendorBookings);

// ── Create and pay ───────────────────────────────────────────────────
router.post("/", authMiddleware, createBooking);
router.post("/verify", authMiddleware, verifyBookingPayment);
router.post("/:id/pay", authMiddleware, initBookingPayment);

// ── Guest actions ────────────────────────────────────────────────────
router.post("/:id/confirm-checkin", authMiddleware, confirmCheckIn);
router.post("/:id/cancel", authMiddleware, cancelBooking);

// ── Host actions ─────────────────────────────────────────────────────
router.patch("/:id/status", authMiddleware, requireVendor, updateBookingStatus);

// ── Detail — LAST, so /my, /vendor, /verify aren't matched as an id ──
router.get("/:id", authMiddleware, getSingleBooking);

export default router;

