// routes/bookingRoute.js
import express from "express";
import authMiddleware from "../middleware/authMiddleWare.js";
import { requireVendor } from "../middleware/requireVendo.js";
import {
  getMyBookings,
  getVendorBookings,
  createBooking,
  updateBookingStatus,
} from "../controllers/bookingController.js";

const router = express.Router();

router.get("/my",           authMiddleware,              getMyBookings);
router.get("/vendor",       authMiddleware, requireVendor, getVendorBookings);
router.post("/",            authMiddleware,              createBooking);
router.patch("/:id/status", authMiddleware, requireVendor, updateBookingStatus);

export default router;
