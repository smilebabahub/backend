// routes/bookingRoutes.js
import express from "express";
import { requireVendor } from "../middleware/requireVendo.js";
import {
  getMyBookings,
  createBooking,
  updateBookingStatus,
} from "../controllers/bookingController.js";
import authMiddleware from "../middleware/authMiddleWare.js";

const router = express.Router();

router.get("/my", authMiddleware, getMyBookings);
router.post("/", authMiddleware, createBooking);
router.patch("/:id/status", authMiddleware, requireVendor, updateBookingStatus);

export default router;
