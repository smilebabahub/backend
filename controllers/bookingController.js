// controllers/bookingController.js
// Handles apartment / short-stay bookings placed by guests.
//
// Schema fields (stored in Booking model):
//   guest         — User ref (the person booking)
//   vendor        — User ref (the property owner)
//   ad            — Ad ref (the property listing)
//   propertyName  — string (snapshot of the ad title)
//   propertyType  — "apartment" | "villa" | "studio" | "short-stay" | etc.
//   checkIn       — Date
//   checkOut      — Date
//   guests        — number (guest count)
//   totalPrice    — number
//   currency      — "GHS" | "NGN"
//   status        — "pending" | "confirmed" | "checked_in" | "checked_out" | "cancelled"
//   txRef         — payment reference

import Booking from "../models/bookingModel.js";

// ── GET /bookings/my ────────────────────────────────────────────────────────
// Returns all bookings placed BY the logged-in user (as a guest/tenant).
export const getMyBookings = async (req, res) => {
  try {
    const userId = req.user.userId;

    const bookings = await Booking.find({ guest: userId })
      .sort({ createdAt: -1 })
      .populate("vendor", "username")
      .lean();

    const serialized = bookings.map((b) => ({
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
    }));

    res.status(200).json({ bookings: serialized });
  } catch (error) {
    console.error("getMyBookings error:", error);
    res.status(500).json({ message: "Failed to fetch bookings" });
  }
};

// ── POST /bookings ──────────────────────────────────────────────────────────
// Create a booking after payment confirmation.
export const createBooking = async (req, res) => {
  try {
    const userId = req.user.userId;
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

    const Ad = (await import("../models/ad.js")).default;
    const ad = await Ad.findById(adId).select("postedBy title category");
    if (!ad)
      return res.status(404).json({ message: "Property listing not found" });

    const booking = await Booking.create({
      guest: userId,
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
  } catch (error) {
    console.error("createBooking error:", error);
    res.status(500).json({ message: "Failed to create booking" });
  }
};

// ── PATCH /bookings/:id/status ──────────────────────────────────────────────
// Vendor confirms, checks in, checks out, or cancels a booking.
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
  } catch (error) {
    console.error("updateBookingStatus error:", error);
    res.status(500).json({ message: "Failed to update booking" });
  }
};
