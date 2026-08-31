// controllers/bookingController.js
//
// Stays — the apartments vertical.
//
//   getMyBookings        — guest's bookings
//   getVendorBookings    — host's received bookings
//   getSingleBooking     — one booking with its journey
//   getAvailability      — booked date ranges, for the calendar
//   createBooking        — server prices it and holds the dates
//   initBookingPayment   — Flutterwave link
//   verifyBookingPayment — app calls this when the browser closes
//   bookingWebhook       — Flutterwave's confirmation
//   updateBookingStatus  — host confirms / checks in / checks out / cancels
//   confirmCheckIn       — guest releases escrow
//   cancelBooking        — guest cancels, refund per policy
//
// WHAT CHANGED FROM THE PREVIOUS VERSION
//   · totalPrice is computed here from the ad's nightly rate. The client
//     may still send one — it's ignored. Previously anyone could book a
//     ₵2,000/night place for ₵1.
//   · Dates are checked against existing bookings, so two guests can't
//     hold the same nights.
//   · The 5% commission is taken, and payment runs through escrow like
//     orders do: the host is paid after the guest confirms check-in.
//
// Every route, field name and response shape the site already uses is
// unchanged — the new fields are additive.
//
// models/bookingModel.js — add:
//   nights:        Number,
//   nightlyRate:   Number,
//   commissionRate:   { type: Number, default: 0.05 },
//   commissionAmount: Number,
//   vendorPayout:     Number,
//   escrowStatus:  { type: String, enum: ["held","released","refunded","disputed","n/a"], default: "held" },
//   flwTxRef: String,
//   flwTxId:  String,
//   paidAt:   Date,
//   checkedInAt: Date,
//   cancelledAt: Date,
//   cancelledBy: String,
//   refundPolicy: { type: { type: String }, window: Number },
//   timeline: [{ status: String, label: String, note: String, actor: String, at: Date }],
//
// status enum — add "paid" and "refunded" to the existing list.
// index — bookingSchema.index({ ad: 1, checkIn: 1, checkOut: 1 });

import Booking from "../models/bookingModel.js";
import Ad from "../models/adModel.js";
import User from "../models/user.js";
import VendorLedger from "../models/vendorLedger.js";
import { sendSMS } from "../lib/smsService.js";
import {
  initializeGatewayPayment,
  verifyGatewayPayment,
  verifyWebhookSignature,
} from "../lib/paymentGateway.js";
import { notify } from "../lib/notify.js";

const COMMISSION_RATE = 0.05;
const money = (n) => Math.round(Number(n || 0) * 100) / 100;
const sym = (c) => (c === "NGN" ? "₦" : "₵");

/** Statuses that actually hold a date range against a property. */
const HOLDING = ["pending", "paid", "confirmed", "checked_in"];

// ═══════════════════════════════════════════════════════════════════════
// DATE HELPERS
// ═══════════════════════════════════════════════════════════════════════

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function countNights(checkIn, checkOut) {
  return Math.max(
    0,
    Math.round((startOfDay(checkOut) - startOfDay(checkIn)) / 86400000),
  );
}

const fmtDate = (d) =>
  new Date(d).toLocaleDateString("en-GH", { day: "numeric", month: "short" });

// ═══════════════════════════════════════════════════════════════════════
// PRICING — the only place a stay's total is decided
// ═══════════════════════════════════════════════════════════════════════

/**
 * Validate the dates and price the stay from the ad's own nightly rate.
 * Throws with a `code` so the caller can return something specific.
 */
function priceStay({ ad, checkIn, checkOut, guests = 1 }) {
  const nightlyRate = money(ad?.price?.amount ?? ad?.price);
  if (!(nightlyRate > 0)) {
    throw coded("This place doesn't have a nightly rate set.", "NO_PRICE");
  }

  const inD = startOfDay(checkIn);
  const outD = startOfDay(checkOut);
  const today = startOfDay(new Date());

  if (isNaN(inD.getTime()) || isNaN(outD.getTime())) {
    throw coded("Choose your check-in and check-out dates.", "INVALID_DATES");
  }
  if (inD < today) {
    throw coded("Check-in can't be in the past.", "PAST_DATE");
  }
  if (outD <= inD) {
    throw coded("Check-out has to be after check-in.", "INVALID_RANGE");
  }

  const nights = countNights(inD, outD);
  if (nights > 365) {
    throw coded(
      "For stays over a year, message the host to arrange it directly.",
      "TOO_LONG",
    );
  }

  const maxGuests = Number(ad?.maxGuests ?? attrNumber(ad, "guests") ?? 0);
  const g = Math.max(1, parseInt(guests, 10) || 1);
  if (maxGuests > 0 && g > maxGuests) {
    throw coded(
      `This place sleeps ${maxGuests} guest${maxGuests === 1 ? "" : "s"}.`,
      "TOO_MANY_GUESTS",
    );
  }

  const minNights = Number(
    ad?.minNights ?? attrNumber(ad, "minimum nights") ?? 0,
  );
  if (minNights > 0 && nights < minNights) {
    throw coded(
      `This place has a ${minNights}-night minimum.`,
      "BELOW_MIN_NIGHTS",
    );
  }

  const subtotal = money(nightlyRate * nights);

  return {
    checkIn: inD,
    checkOut: outD,
    nights,
    guests: g,
    nightlyRate,
    subtotal,
    commissionAmount: money(subtotal * COMMISSION_RATE),
    vendorPayout: money(subtotal - subtotal * COMMISSION_RATE),
  };
}

/**
 * Is the property free for these dates?
 *
 * Two stays clash when one starts before the other ends and ends after the
 * other starts. Equal boundaries don't clash — one guest checking out on
 * the 5th and another checking in on the 5th is fine.
 */
async function checkAvailability({ adId, checkIn, checkOut, excludeId }) {
  const filter = {
    ad: adId,
    status: { $in: HOLDING },
    checkIn: { $lt: startOfDay(checkOut) },
    checkOut: { $gt: startOfDay(checkIn) },
  };
  if (excludeId) filter._id = { $ne: excludeId };

  const clash = await Booking.findOne(filter).select("checkIn checkOut").lean();

  return {
    available: !clash,
    conflictsWith: clash
      ? { checkIn: clash.checkIn, checkOut: clash.checkOut }
      : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// TIMELINE
// ═══════════════════════════════════════════════════════════════════════

const EVENTS = {
  placed: { label: "Booking requested", note: "Waiting for payment." },
  paid: {
    label: "Payment received",
    note: "We're holding your payment until you check in.",
  },
  confirmed: { label: "Host confirmed", note: "Your stay is booked." },
  checked_in: { label: "Checked in", note: "Enjoy your stay." },
  checked_out: {
    label: "Checked out",
    note: "Thanks for staying with SmileBaba.",
  },
  cancelled: { label: "Cancelled", note: "This booking was cancelled." },
  refunded: { label: "Refunded", note: "Your money is on its way back." },
};

function addEvent(booking, event, { actor = "system", note } = {}) {
  const copy = EVENTS[event] ?? { label: event };
  booking.timeline = booking.timeline ?? [];

  const last = booking.timeline[booking.timeline.length - 1];
  if (
    last &&
    last.status === event &&
    Date.now() - new Date(last.at).getTime() < 60_000
  ) {
    return; // duplicate guard
  }

  booking.timeline.push({
    status: event,
    label: copy.label,
    note: note ?? copy.note,
    actor,
    at: new Date(),
  });
}

function buildJourney(booking) {
  const done = new Map((booking.timeline ?? []).map((t) => [t.status, t]));

  if (["cancelled", "refunded"].includes(booking.status)) {
    return (booking.timeline ?? []).map((t) => ({
      key: t.status,
      label: t.label,
      note: t.note,
      at: t.at,
      state: "done",
    }));
  }

  const steps = ["placed", "paid", "confirmed", "checked_in", "checked_out"];
  const lastIdx = steps.reduce((acc, k, i) => (done.has(k) ? i : acc), -1);

  return steps.map((k, i) => {
    const entry = done.get(k);
    return {
      key: k,
      label: entry?.label ?? EVENTS[k].label,
      note: entry?.note ?? EVENTS[k].note,
      at: entry?.at ?? null,
      state: i <= lastIdx ? "done" : i === lastIdx + 1 ? "current" : "upcoming",
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════
// GET /bookings/my
// ═══════════════════════════════════════════════════════════════════════
export const getMyBookings = async (req, res) => {
  try {
    const filter = { guest: req.user.userId };
    if (req.query.status && req.query.status !== "all") {
      filter.status = req.query.status;
    }

    const bookings = await Booking.find(filter)
      .sort({ createdAt: -1 })
      .populate("vendor", "username storeName storePhone")
      .populate("ad", "title coverImage images")
      .lean();

    res.status(200).json({
      bookings: bookings.map((b) => ({
        _id: String(b._id),
        reference: String(b._id).slice(-6).toUpperCase(),
        propertyName: b.propertyName ?? b.ad?.title ?? "Property",
        propertyType: b.propertyType ?? "apartment",
        image: b.ad?.coverImage ?? b.ad?.images?.[0]?.url ?? null,
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        nights: b.nights ?? countNights(b.checkIn, b.checkOut),
        guests: b.guests ?? 1,
        nightlyRate: b.nightlyRate ?? null,
        totalPrice: b.totalPrice ?? 0,
        currency: b.currency ?? "GHS",
        symbol: sym(b.currency ?? "GHS"),
        status: b.status ?? "pending",
        escrowStatus: b.escrowStatus ?? null,
        // Kept as a plain username for backward compatibility with the site
        vendor: b.vendor?.storeName ?? b.vendor?.username ?? "Unknown host",
        vendorId: b.vendor?._id ? String(b.vendor._id) : null,
        adId: b.ad?._id ? String(b.ad._id) : null,
        createdAt: b.createdAt,
      })),
    });
  } catch (err) {
    console.error("getMyBookings error:", err);
    res.status(500).json({ message: "Failed to fetch bookings" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /bookings/vendor
// ═══════════════════════════════════════════════════════════════════════
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
        .populate("ad", "title coverImage images")
        .lean(),
    ]);

    res.status(200).json({
      bookings: bookings.map((b) => ({
        _id: String(b._id),
        reference: String(b._id).slice(-6).toUpperCase(),
        propertyName: b.propertyName ?? b.ad?.title ?? "Property",
        propertyType: b.propertyType ?? "apartment",
        image: b.ad?.coverImage ?? b.ad?.images?.[0]?.url ?? null,
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        nights: b.nights ?? countNights(b.checkIn, b.checkOut),
        guests: b.guests ?? 1,
        totalPrice: b.totalPrice ?? 0,
        vendorPayout: b.vendorPayout ?? null,
        currency: b.currency ?? "GHS",
        symbol: sym(b.currency ?? "GHS"),
        status: b.status ?? "pending",
        escrowStatus: b.escrowStatus ?? null,
        guest: b.guest?.username ?? "Guest",
        // The guest's number unlocks once they've paid — an unpaid
        // enquiry is not a free lead.
        guestPhone: b.status === "pending" ? "" : (b.guest?.phone ?? ""),
        createdAt: b.createdAt,
      })),
      meta: { total, page: Number(page), limit: Number(limit) },
    });
  } catch (err) {
    console.error("getVendorBookings error:", err);
    res.status(500).json({ message: "Failed to fetch bookings" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /bookings/availability/:adId — public, feeds the calendar
// ═══════════════════════════════════════════════════════════════════════
export const getAvailability = async (req, res) => {
  try {
    const filter = {
      ad: req.params.adId,
      status: { $in: HOLDING },
      checkOut: { $gte: startOfDay(new Date()) },
    };

    const bookings = await Booking.find(filter)
      .select("checkIn checkOut")
      .lean();

    res.status(200).json({
      booked: bookings.map((b) => ({
        checkIn: b.checkIn,
        checkOut: b.checkOut,
      })),
    });
  } catch (err) {
    console.error("getAvailability error:", err);
    res.status(500).json({ message: "Failed to load availability" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /bookings/:id
// ═══════════════════════════════════════════════════════════════════════
export const getSingleBooking = async (req, res) => {
  try {
    const b = await Booking.findById(req.params.id)
      .populate("vendor", "username storeName storePhone storeSlug")
      .populate("guest", "username phone email")
      .populate("ad", "title coverImage images location")
      .lean();

    if (!b) return res.status(404).json({ message: "Booking not found" });

    const uid = String(req.user.userId);
    const isGuest = String(b.guest?._id ?? b.guest) === uid;
    const isHost = String(b.vendor?._id ?? b.vendor) === uid;
    if (!isGuest && !isHost && req.user.role !== "admin") {
      return res.status(403).json({ message: "Not authorised" });
    }

    res.status(200).json({ booking: serialise(b, { isHost }) });
  } catch (err) {
    console.error("getSingleBooking error:", err);
    res.status(500).json({ message: "Failed to fetch booking" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /bookings
//
// Body: { adId, checkIn, checkOut, guests, propertyName?, propertyType? }
//
// totalPrice and currency may still be sent by older clients — both are
// ignored and recomputed from the listing.
// ═══════════════════════════════════════════════════════════════════════
export const createBooking = async (req, res) => {
  try {
    const guestId = req.user.userId;
    const { adId, checkIn, checkOut, guests, propertyName, propertyType } =
      req.body;

    if (!adId || !checkIn || !checkOut) {
      return res.status(400).json({
        message: "Property, check-in and check-out are required.",
      });
    }

    const ad = await Ad.findById(adId)
      .populate("postedBy", "username storeName phone flwSubaccountId")
      .lean();

    if (!ad) {
      return res.status(404).json({ message: "Property listing not found" });
    }
    if (ad.isSold || ad.isPaused || ad.isActive === false) {
      return res.status(400).json({
        message: "This place isn't taking bookings right now.",
        code: "UNAVAILABLE",
      });
    }
    if (String(ad.postedBy?._id) === String(guestId)) {
      return res.status(400).json({
        message: "You can't book your own listing.",
        code: "OWN_LISTING",
      });
    }

    // ── Price it here. The client's number is never trusted. ─────────
    let stay;
    try {
      stay = priceStay({ ad, checkIn, checkOut, guests });
    } catch (err) {
      return res.status(400).json({ message: err.message, code: err.code });
    }

    // ── Hold the dates ───────────────────────────────────────────────
    const free = await checkAvailability({
      adId,
      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
    });
    if (!free.available) {
      return res.status(409).json({
        message: "Those dates have just been taken. Please pick another range.",
        code: "DATES_UNAVAILABLE",
        conflictsWith: free.conflictsWith,
      });
    }

    const currency =
      ad.price?.currency ??
      (ad.location?.country === "Nigeria" ? "NGN" : "GHS");

    const booking = await Booking.create({
      guest: guestId,
      vendor: ad.postedBy._id,
      ad: adId,
      propertyName: propertyName ?? ad.title,
      propertyType: propertyType ?? "apartment",

      checkIn: stay.checkIn,
      checkOut: stay.checkOut,
      nights: stay.nights,
      guests: stay.guests,

      nightlyRate: stay.nightlyRate,
      totalPrice: stay.subtotal,
      currency,
      commissionRate: COMMISSION_RATE,
      commissionAmount: stay.commissionAmount,
      vendorPayout: stay.vendorPayout,

      status: "pending",
      escrowStatus: "held",
      // Cancel free until the host confirms; after that it's their call
      refundPolicy: { type: "before_confirm" },

      timeline: [
        {
          status: "placed",
          label: "Booking requested",
          note: "Waiting for payment.",
          actor: "buyer",
          at: new Date(),
        },
      ],
    });

    res.status(201).json({
      message: "Booking created successfully",
      booking: serialise(booking),
    });

    // ── Tell the host ────────────────────────────────────────────────
    const vendor = await User.findById(ad.postedBy._id)
      .select("phone username")
      .lean();

    if (vendor?.phone) {
      sendSMS(
        vendor.phone,
        `SmileBaba: New booking for "${booking.propertyName}" — ` +
          `${sym(currency)}${stay.subtotal.toLocaleString()} for ${stay.nights} night${stay.nights === 1 ? "" : "s"}. ` +
          `Check-in: ${fmtDate(stay.checkIn)}, Check-out: ${fmtDate(stay.checkOut)}. ` +
          `Confirm at: https://smilebabahub.com/vendor/orders`,
      ).catch((e) => console.error("[SMS booking]", e.message));
    }

    notify({
      userId: ad.postedBy._id,
      type: "boost_approved",
      title: "New booking request",
      message:
        `${stay.nights} night${stay.nights === 1 ? "" : "s"} at ${booking.propertyName} — ` +
        `${sym(currency)}${stay.subtotal.toLocaleString()}. Awaiting payment.`,
      actionUrl: "/vendor/bookings",
      actionLabel: "View booking",
      dedupeKey: `booking-${booking._id}-placed`,
      data: { bookingId: String(booking._id) },
    }).catch(() => {});
  } catch (err) {
    console.error("createBooking error:", err);
    res.status(500).json({ message: "Failed to create booking" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /bookings/:id/pay
// ═══════════════════════════════════════════════════════════════════════
export const initBookingPayment = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    if (String(booking.guest) !== String(req.user.userId)) {
      return res.status(403).json({ message: "Not authorised" });
    }
    if (booking.status !== "pending") {
      return res.status(409).json({
        message: "This booking has already been paid for.",
        currentStatus: booking.status,
      });
    }

    // Someone else may have taken the dates while this sat unpaid
    const free = await checkAvailability({
      adId: booking.ad,
      checkIn: booking.checkIn,
      checkOut: booking.checkOut,
      excludeId: booking._id,
    });
    if (!free.available) {
      booking.status = "cancelled";
      booking.cancelledAt = new Date();
      booking.cancelledBy = "system";
      addEvent(booking, "cancelled", {
        actor: "system",
        note: "Those dates were booked by someone else first.",
      });
      await booking.save();

      return res.status(409).json({
        message:
          "Those dates were taken while you were deciding. Please pick another range.",
        code: "DATES_UNAVAILABLE",
      });
    }

    const guest = await User.findById(booking.guest)
      .select("email username phone whatsapp")
      .lean();

    const tx_ref = `smilebaba-stay-${booking._id}-${Date.now()}`;
    booking.flwTxRef = tx_ref;
    await booking.save();

    const frontendBase = (
      process.env.NEXT_PUBLIC_APP_URL ??
      process.env.FRONTEND_URL ??
      "https://www.smilebabahub.com"
    ).replace(/\/+$/, "");

    const { paymentLink } = await initializeGatewayPayment({
      countryCode: booking.currency === "NGN" ? "NG" : "GH",
      payload: {
        tx_ref,
        amount: booking.totalPrice,
        currency: booking.currency,
        redirect_url: `${frontendBase}/bookings/complete?ref=${tx_ref}`,
        customer: {
          email: guest?.email ?? "guest@smilebabahub.com",
          name: guest?.username ?? "SmileBaba guest",
          phonenumber: guest?.phone ?? guest?.whatsapp ?? "0000000000",
        },
        meta: {
          purpose: "booking",
          bookingId: String(booking._id),
          guestId: String(booking.guest),
        },
        customizations: {
          title: "SmileBaba Stays",
          description: `${booking.nights} night${booking.nights === 1 ? "" : "s"} at ${booking.propertyName}`,
          logo: `${frontendBase}/logo.png`,
          color: "#0d9488",
        },
      },
    });

    res.status(200).json({
      paymentLink,
      link: paymentLink,
      checkoutUrl: paymentLink,
      tx_ref,
      bookingId: String(booking._id),
      amount: booking.totalPrice,
      currency: booking.currency,
    });
  } catch (err) {
    const msg = err.response?.data?.message ?? err.message;
    console.error("initBookingPayment error:", msg);
    res.status(500).json({
      message: typeof msg === "string" ? msg : "Payment initialisation failed",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /bookings/verify   { bookingId }
// ═══════════════════════════════════════════════════════════════════════
export const verifyBookingPayment = async (req, res) => {
  try {
    const { bookingId, transaction_id } = req.body;
    if (!bookingId) {
      return res.status(400).json({ message: "bookingId is required" });
    }

    const booking = await Booking.findById(bookingId);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    if (String(booking.guest) !== String(req.user.userId)) {
      return res.status(403).json({ message: "Not authorised" });
    }

    if (booking.status !== "pending") {
      return res.status(200).json({
        status: "paid",
        booking: serialise(booking),
      });
    }

    let payment;
    try {
      payment = await verifyGatewayPayment({
        countryCode: booking.currency === "NGN" ? "NG" : "GH",
        transactionId: transaction_id ?? booking.flwTxRef,
      });
    } catch (e) {
      console.warn("[verifyBookingPayment] lookup failed:", e.message);
      return res.status(200).json({
        status: "pending",
        booking: serialise(booking),
      });
    }

    if (payment?.status !== "successful") {
      return res.status(200).json({
        status: payment?.status === "pending" ? "pending" : "failed",
        booking: serialise(booking),
      });
    }

    const diff = Number(payment.amount) - booking.totalPrice;
    if (diff < 0 && Math.abs(diff) / booking.totalPrice > 0.05) {
      console.error("[verifyBookingPayment] underpayment", {
        paid: payment.amount,
        expected: booking.totalPrice,
      });
      return res.status(400).json({
        message: "Payment amount doesn't match this booking",
      });
    }

    await markBookingPaid({ booking, payment });

    const fresh = await Booking.findById(bookingId).lean();
    res.status(200).json({ status: "paid", booking: serialise(fresh) });
  } catch (err) {
    console.error("verifyBookingPayment error:", err);
    res.status(500).json({ message: "Verification failed" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /bookings/webhook — Flutterwave. Needs raw body in server.js.
// ═══════════════════════════════════════════════════════════════════════
export const bookingWebhook = async (req, res) => {
  try {
    const isValid = verifyWebhookSignature({
      countryCode: req.countryCode ?? "GH",
      headers: req.headers,
      body: req.body,
    });
    if (!isValid) return res.status(401).end();

    const payload = Buffer.isBuffer(req.body)
      ? JSON.parse(req.body.toString("utf8"))
      : req.body;

    const ok =
      (payload.event === "charge.completed" ||
        payload.event === "charge.success") &&
      (payload.data?.status === "successful" ||
        payload.data?.status === "success");
    if (!ok) return res.status(200).end();

    const data = payload.data;
    const rawMeta = data.meta ?? data.payment_meta ?? data.metadata ?? {};
    const meta = Array.isArray(rawMeta)
      ? rawMeta.reduce((acc, i) => ({ ...acc, [i.metaname]: i.metavalue }), {})
      : rawMeta;

    if (meta.purpose !== "booking" || !meta.bookingId) {
      return res.status(200).end();
    }

    const booking = await Booking.findById(meta.bookingId);
    if (!booking || booking.status !== "pending") return res.status(200).end();

    const amount = Number(data.charged_amount ?? data.amount);
    const diff = amount - booking.totalPrice;
    if (diff < 0 && Math.abs(diff) / booking.totalPrice > 0.05) {
      console.error("[bookingWebhook] underpayment", {
        paid: amount,
        expected: booking.totalPrice,
      });
      return res.status(200).end();
    }

    await markBookingPaid({
      booking,
      payment: { id: data.id, amount, currency: data.currency },
    });

    res.status(200).end();
  } catch (err) {
    console.error("bookingWebhook error:", err);
    res.status(200).end(); // never trigger a retry loop
  }
};

// ═══════════════════════════════════════════════════════════════════════
// PATCH /bookings/:id/status — host moves the booking along
// ═══════════════════════════════════════════════════════════════════════
export const updateBookingStatus = async (req, res) => {
  try {
    const { status, note } = req.body;
    const valid = ["confirmed", "checked_in", "checked_out", "cancelled"];
    if (!valid.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    if (String(booking.vendor) !== String(req.user.userId)) {
      return res.status(403).json({ message: "Not authorised" });
    }

    if (booking.status === "pending" && status !== "cancelled") {
      return res.status(409).json({
        message: "This booking hasn't been paid for yet.",
      });
    }

    booking.status = status;
    addEvent(booking, status, { actor: "vendor", note });

    if (status === "checked_in") booking.checkedInAt = new Date();

    // Check-out is the last moment escrow can sensibly be held. If the
    // guest never confirmed check-in, release it here.
    if (status === "checked_out" && booking.escrowStatus === "held") {
      await releaseEscrow({ booking, actor: "vendor" });
    }

    if (status === "cancelled") {
      booking.cancelledAt = new Date();
      booking.cancelledBy = "vendor";
      // Host cancelling always refunds the guest in full
      if (booking.escrowStatus === "held") {
        booking.escrowStatus = "refunded";
        await VendorLedger.updateMany(
          { booking: booking._id, status: "pending" },
          { $set: { status: "available", notes: "Reversed — host cancelled" } },
        );
      }
    }

    await booking.save();
    res.status(200).json({ message: "Booking status updated", booking });

    // ── Tell the guest ───────────────────────────────────────────────
    const guest = await User.findById(booking.guest).select("phone").lean();
    const inFmt = fmtDate(booking.checkIn);

    const copy = {
      confirmed: {
        title: "Booking confirmed",
        body: `Your stay at ${booking.propertyName} is confirmed for ${inFmt}.`,
        sms: `SmileBaba: Your booking for "${booking.propertyName}" is confirmed! See you on ${inFmt}.`,
      },
      checked_in: {
        title: "Checked in",
        body: "Confirm your check-in in the app so the host can be paid.",
        sms: `SmileBaba: You've been checked in to "${booking.propertyName}". Enjoy your stay!`,
      },
      checked_out: {
        title: "Checked out",
        body: "Thanks for staying with SmileBaba.",
        sms: `SmileBaba: Check-out complete for "${booking.propertyName}". Thanks for staying with us!`,
      },
      cancelled: {
        title: "Booking cancelled",
        body: note ?? "The host cancelled. You'll be refunded in full.",
        sms: `SmileBaba: Your booking for "${booking.propertyName}" was cancelled. You'll be refunded in full.`,
      },
    }[status];

    notify({
      userId: booking.guest,
      type: "boost_approved",
      title: copy.title,
      message: copy.body,
      actionUrl: `/bookings/${booking._id}`,
      actionLabel: "View booking",
      dedupeKey: `booking-${booking._id}-${status}`,
      data: { bookingId: String(booking._id), status },
    }).catch(() => {});

    if (guest?.phone) {
      sendSMS(guest.phone, copy.sms).catch((e) =>
        console.error("[SMS booking status]", e.message),
      );
    }
  } catch (err) {
    console.error("updateBookingStatus error:", err);
    res.status(500).json({ message: "Failed to update booking" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /bookings/:id/confirm-checkin — guest releases escrow
// ═══════════════════════════════════════════════════════════════════════
export const confirmCheckIn = async (req, res) => {
  try {
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    if (String(booking.guest) !== String(req.user.userId)) {
      return res.status(403).json({ message: "Not authorised" });
    }
    if (!["paid", "confirmed", "checked_in"].includes(booking.status)) {
      return res.status(409).json({
        message: `Can't confirm check-in when the booking is "${booking.status}".`,
      });
    }
    if (booking.escrowStatus === "released") {
      return res.status(200).json({
        message: "Already confirmed.",
        booking: serialise(booking),
      });
    }

    booking.status = "checked_in";
    booking.checkedInAt = booking.checkedInAt ?? new Date();
    addEvent(booking, "checked_in", { actor: "buyer" });
    await releaseEscrow({ booking, actor: "buyer" });
    await booking.save();

    res.status(200).json({
      message: "Check-in confirmed. The host has been paid.",
      booking: serialise(booking),
    });

    notify({
      userId: booking.vendor,
      type: "boost_approved",
      title: "Payment released",
      message:
        `Guest confirmed check-in at ${booking.propertyName}. ` +
        `${sym(booking.currency)}${(booking.vendorPayout ?? 0).toLocaleString()} added to your balance.`,
      actionUrl: "/vendor/dashboard",
      actionLabel: "View earnings",
      dedupeKey: `booking-${booking._id}-released`,
      data: { bookingId: String(booking._id) },
    }).catch(() => {});
  } catch (err) {
    console.error("confirmCheckIn error:", err);
    res.status(500).json({ message: "Failed to confirm check-in" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /bookings/:id/cancel — guest cancels
// ═══════════════════════════════════════════════════════════════════════
export const cancelBooking = async (req, res) => {
  try {
    const { reason } = req.body;
    const booking = await Booking.findById(req.params.id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    if (String(booking.guest) !== String(req.user.userId)) {
      return res.status(403).json({ message: "Not authorised" });
    }
    if (["checked_in", "checked_out", "cancelled"].includes(booking.status)) {
      return res.status(409).json({
        message: "This booking can no longer be cancelled.",
      });
    }

    // Free to cancel before the host confirms. After that it's the host's
    // call, so the request goes to them rather than cancelling outright.
    const freeCancel = ["pending", "paid"].includes(booking.status);

    if (!freeCancel) {
      return res.status(409).json({
        message:
          "This booking is confirmed. Message the host to arrange a cancellation.",
        code: "HOST_APPROVAL_REQUIRED",
      });
    }

    booking.status = "cancelled";
    booking.cancelledAt = new Date();
    booking.cancelledBy = "guest";
    addEvent(booking, "cancelled", { actor: "buyer", note: reason });

    if (booking.escrowStatus === "held") {
      booking.escrowStatus = "refunded";
      await VendorLedger.updateMany(
        { booking: booking._id, status: "pending" },
        { $set: { status: "available", notes: "Reversed — guest cancelled" } },
      );
    }

    await booking.save();

    res.status(200).json({
      message: booking.paidAt
        ? "Booking cancelled. Your refund is on its way."
        : "Booking cancelled.",
      booking: serialise(booking),
    });

    notify({
      userId: booking.vendor,
      type: "boost_approved",
      title: "Booking cancelled",
      message:
        `${fmtDate(booking.checkIn)}–${fmtDate(booking.checkOut)} at ` +
        `${booking.propertyName} is free again.`,
      actionUrl: "/vendor/bookings",
      actionLabel: "View bookings",
      dedupeKey: `booking-${booking._id}-cancelled`,
      data: { bookingId: String(booking._id) },
    }).catch(() => {});
  } catch (err) {
    console.error("cancelBooking error:", err);
    res.status(500).json({ message: "Failed to cancel booking" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// INTERNAL
// ═══════════════════════════════════════════════════════════════════════

async function markBookingPaid({ booking, payment }) {
  if (booking.status !== "pending") return;

  booking.status = "paid";
  booking.paidAt = new Date();
  booking.flwTxId = String(payment.id ?? "");
  addEvent(booking, "paid", { actor: "system" });

  await VendorLedger.create({
    vendor: booking.vendor,
    amount: booking.vendorPayout ?? 0,
    currency: booking.currency,
    booking: booking._id,
    type: "sale",
    status: "pending", // becomes available when the guest checks in
    notes: `Stay at ${booking.propertyName} — pending check-in`,
  });

  await booking.save();

  notify({
    userId: booking.guest,
    type: "boost_approved",
    title: "Payment received",
    message: `Your stay at ${booking.propertyName} is booked. We're holding your payment until you check in.`,
    actionUrl: `/bookings/${booking._id}`,
    actionLabel: "View booking",
    dedupeKey: `booking-${booking._id}-paid`,
    data: { bookingId: String(booking._id) },
  }).catch(() => {});

  notify({
    userId: booking.vendor,
    type: "boost_approved",
    title: "Booking paid",
    message:
      `${sym(booking.currency)}${booking.totalPrice.toLocaleString()} paid for ` +
      `${fmtDate(booking.checkIn)}–${fmtDate(booking.checkOut)}. Confirm the booking.`,
    actionUrl: "/vendor/bookings",
    actionLabel: "Confirm booking",
    dedupeKey: `booking-${booking._id}-vendor-paid`,
    data: { bookingId: String(booking._id) },
  }).catch(() => {});
}

async function releaseEscrow({ booking, actor }) {
  if (booking.escrowStatus !== "held") return;

  booking.escrowStatus = "released";
  booking.escrowReleasedAt = new Date();

  await VendorLedger.updateMany(
    { booking: booking._id, type: "sale", status: "pending" },
    {
      $set: {
        status: "available",
        notes: `Released on ${actor} check-in confirmation`,
      },
    },
  );
}

function serialise(b, { isHost = false } = {}) {
  const raw = b.toObject ? b.toObject() : b;
  const currency = raw.currency ?? "GHS";

  return {
    _id: String(raw._id),
    reference: String(raw._id).slice(-6).toUpperCase(),
    propertyName: raw.propertyName ?? raw.ad?.title ?? "Property",
    propertyType: raw.propertyType ?? "apartment",
    image: raw.ad?.coverImage ?? raw.ad?.images?.[0]?.url ?? null,

    checkIn: raw.checkIn,
    checkOut: raw.checkOut,
    nights: raw.nights ?? countNights(raw.checkIn, raw.checkOut),
    guests: raw.guests ?? 1,

    nightlyRate: raw.nightlyRate ?? null,
    totalPrice: raw.totalPrice ?? 0,
    currency,
    symbol: sym(currency),
    display: {
      nightlyRate: raw.nightlyRate
        ? `${sym(currency)}${Number(raw.nightlyRate).toLocaleString()}`
        : null,
      totalPrice: `${sym(currency)}${Number(raw.totalPrice ?? 0).toLocaleString()}`,
    },

    status: raw.status ?? "pending",
    escrowStatus: raw.escrowStatus ?? null,
    timeline: raw.timeline ?? [],
    journey: buildJourney(raw),

    vendor: raw.vendor?._id
      ? {
          _id: String(raw.vendor._id),
          name: raw.vendor.storeName ?? raw.vendor.username,
          phone: raw.status === "pending" ? null : raw.vendor.storePhone,
          storeSlug: raw.vendor.storeSlug,
        }
      : null,
    guest: isHost && raw.guest?._id ? raw.guest : undefined,

    adId: raw.ad?._id ? String(raw.ad._id) : raw.ad ? String(raw.ad) : null,
    paidAt: raw.paidAt ?? null,
    checkedInAt: raw.checkedInAt ?? null,
    cancelledAt: raw.cancelledAt ?? null,
    createdAt: raw.createdAt,
  };
}

function coded(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function attrNumber(ad, key) {
  if (!Array.isArray(ad?.attributes)) return null;
  const wanted = String(key).toLowerCase();
  for (const a of ad.attributes) {
    const k = String(a?.key ?? a?.name ?? a?.label ?? "").toLowerCase();
    if (k === wanted) {
      const n = parseInt(String(a?.value).replace(/\D/g, ""), 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
