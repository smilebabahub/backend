// controllers/bookingController.js
import Booking from "../models/bookingModel.js";
import Ad from "../models/adModel.js";
import User from "../models/user.js";
import { sendSMS } from "../lib/smsService.js";

// ── GET /bookings/my — guest's bookings ────────────────────────────────────
export const getMyBookings = async (req, res) => {
  try {
    const bookings = await Booking.find({ guest: req.user.userId })
      .sort({ createdAt: -1 })
      .populate("vendor", "username")
      .lean();

    res.status(200).json({
      bookings: bookings.map((b) => ({
        _id: String(b._id),
        propertyName: b.propertyName ?? "Property",
        propertyType: b.propertyType ?? "apartment",
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        guests: b.guests ?? 1,
        totalPrice: b.totalPrice ?? 0,
        currency: b.currency ?? "GHS",
        status: b.status ?? "pending",
        vendor: b.vendor?.username ?? "Unknown host",
        createdAt: b.createdAt,
      })),
    });
  } catch (err) {
    console.error("getMyBookings error:", err);
    res.status(500).json({ message: "Failed to fetch bookings" });
  }
};

// ── GET /bookings/vendor — vendor's received bookings ──────────────────────
export const getVendorBookings = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { vendor: req.user.userId };
    if (status && status !== "all") filter.status = status;

    const skip = (Number(page) - 1) * Number(limit);
    const [total, bookings] = await Promise.all([
      Booking.countDocuments(filter),
      Booking.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate("guest", "username phone")
        .lean(),
    ]);

    res.status(200).json({
      bookings: bookings.map((b) => ({
        _id: String(b._id),
        propertyName: b.propertyName ?? "Property",
        propertyType: b.propertyType ?? "apartment",
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        guests: b.guests ?? 1,
        totalPrice: b.totalPrice ?? 0,
        currency: b.currency ?? "GHS",
        status: b.status ?? "pending",
        guest: b.guest?.username ?? "Guest",
        guestPhone: b.guest?.phone ?? "",
        createdAt: b.createdAt,
      })),
      meta: { total, page: Number(page), limit: Number(limit) },
    });
  } catch (err) {
    console.error("getVendorBookings error:", err);
    res.status(500).json({ message: "Failed to fetch bookings" });
  }
};

// ── POST /bookings ──────────────────────────────────────────────────────────
export const createBooking = async (req, res) => {
  try {
    const guestId = req.user.userId;
    const {
      adId,
      propertyName,
      propertyType,
      checkIn,
      checkOut,
      guests,
      totalPrice,
      currency,
      txRef,
    } = req.body;

    if (!adId || !checkIn || !checkOut || !totalPrice || !currency) {
      return res
        .status(400)
        .json({ message: "Missing required booking fields" });
    }

    const ad = await Ad.findById(adId).select("postedBy title");
    if (!ad)
      return res.status(404).json({ message: "Property listing not found" });

    const booking = await Booking.create({
      guest: guestId,
      vendor: ad.postedBy,
      ad: adId,
      propertyName: propertyName ?? ad.title,
      propertyType: propertyType ?? "apartment",
      checkIn: new Date(checkIn),
      checkOut: new Date(checkOut),
      guests: guests ?? 1,
      totalPrice,
      currency,
      txRef,
      status: "pending",
    });

    res.status(201).json({ message: "Booking created successfully", booking });

    // ── SMS to vendor (non-blocking) ──────────────────────────────────────
    const sym = currency === "NGN" ? "₦" : "₵";
    const checkInFmt = new Date(checkIn).toLocaleDateString("en-GH", {
      day: "numeric",
      month: "short",
    });
    const checkOutFmt = new Date(checkOut).toLocaleDateString("en-GH", {
      day: "numeric",
      month: "short",
    });
    const vendor = await User.findById(ad.postedBy)
      .select("phone username")
      .lean();
    if (vendor?.phone) {
      sendSMS(
        vendor.phone,
        `SmileBaba: New booking for "${booking.propertyName}" — ${sym}${Number(totalPrice).toLocaleString()}. ` +
          `Check-in: ${checkInFmt}, Check-out: ${checkOutFmt}. ` +
          `Confirm at: https://smilebabahub.com/vendor/orders`,
      ).catch((e) => console.error("[SMS booking]", e.message));
    }
  } catch (err) {
    console.error("createBooking error:", err);
    res.status(500).json({ message: "Failed to create booking" });
  }
};

// ── PATCH /bookings/:id/status ──────────────────────────────────────────────
export const updateBookingStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ["confirmed", "checked_in", "checked_out", "cancelled"];
    if (!valid.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    if (String(booking.vendor) !== req.user.userId) {
      return res.status(403).json({ message: "Not authorised" });
    }

    booking.status = status;
    await booking.save();

    res.status(200).json({ message: "Booking status updated", booking });

    // ── SMS to guest on status change ──────────────────────────────────────
    const guest = await User.findById(booking.guest).select("phone").lean();
    if (guest?.phone) {
      const msgs = {
        confirmed: `SmileBaba: Your booking for "${booking.propertyName}" is confirmed! See you on ${new Date(booking.checkIn).toLocaleDateString("en-GH", { day: "numeric", month: "short" })}.`,
        checked_in: `SmileBaba: You've been checked in to "${booking.propertyName}". Enjoy your stay! 🏠`,
        checked_out: `SmileBaba: Check-out complete for "${booking.propertyName}". Thanks for staying with us!`,
        cancelled: `SmileBaba: Your booking for "${booking.propertyName}" was cancelled. Contact support if unexpected.`,
      };
      sendSMS(guest.phone, msgs[status]).catch((e) =>
        console.error("[SMS booking status]", e.message),
      );
    }
  } catch (err) {
    console.error("updateBookingStatus error:", err);
    res.status(500).json({ message: "Failed to update booking" });
  }
};
