// controllers/marketerController.js
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Marketer from "../models/marketerModel.js";
import {
  cacheReferralCode,
  getReferralCode,
  invalidateReferralCode,
} from "../lib/redis.js";

const cookieOptions = () => {
  const isProd = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
  };
};

// ── REGISTER ───────────────────────────────────────────────────────────────
export const registerMarketer = async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    if (!name || !email || !phone || !password) {
      return res.status(400).json({ message: "All fields required" });
    }

    const exists = await Marketer.findOne({ email });
    if (exists) {
      return res.status(409).json({ message: "Email already registered" });
    }

    const hashed = await bcrypt.hash(password, 10);
    const marketer = await Marketer.create({
      name,
      email,
      phone,
      password: hashed,
    });

    // Warm the Redis cache immediately so first referral lookup is instant
    await cacheReferralCode(marketer.referralCode, marketer._id);

    res.status(201).json({
      message: "Marketer registered successfully",
      marketer: serializeMarketer(marketer),
    });
  } catch (error) {
    console.error("registerMarketer error:", error);
    res.status(500).json({ message: "Registration failed" });
  }
};

// ── LOGIN ──────────────────────────────────────────────────────────────────
export const loginMarketer = async (req, res) => {
  try {
    const { email, password } = req.body;

    const marketer = await Marketer.findOne({ email });
    if (!marketer)
      return res.status(400).json({ message: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, marketer.password);
    if (!isMatch)
      return res.status(400).json({ message: "Invalid credentials" });

    if (!marketer.isActive) {
      return res
        .status(403)
        .json({ message: "Account deactivated. Contact support." });
    }

    marketer.lastLogin = new Date();
    await marketer.save();

    const accessToken = jwt.sign(
      { marketerId: marketer._id, role: "marketer" },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: "24h" },
    );

    const refreshToken = jwt.sign(
      { marketerId: marketer._id },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: "7d" },
    );

    const opts = cookieOptions();
    res.cookie("marketerAccessToken", accessToken, {
      ...opts,
      maxAge: 24 * 60 * 60 * 1000,
    });
    res.cookie("marketerRefreshToken", refreshToken, {
      ...opts,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      message: "Login successful",
      accessToken,
      marketer: serializeMarketer(marketer),
    });
  } catch (error) {
    console.error("loginMarketer error:", error);
    res.status(500).json({ message: "Login failed" });
  }
};

// ── DASHBOARD ──────────────────────────────────────────────────────────────
export const getMarketerDashboard = async (req, res) => {
  try {
    const marketer = await Marketer.findById(req.marketer.marketerId).select(
      "-password",
    );

    if (!marketer)
      return res.status(404).json({ message: "Marketer not found" });

    // Recent commissions — last 20
    const recentCommissions = marketer.commissions
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20);

    res.status(200).json({
      marketer: serializeMarketer(marketer),
      recentCommissions,
      stats: {
        totalReferrals: marketer.totalReferrals,
        activeReferrals: marketer.activeReferrals,
        totalEarningsGHS: marketer.totalEarningsGHS,
        totalEarningsNGN: marketer.totalEarningsNGN,
        pendingPayoutGHS: marketer.pendingPayoutGHS,
        pendingPayoutNGN: marketer.pendingPayoutNGN,
      },
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to load dashboard" });
  }
};

// ── VALIDATE REFERRAL CODE (called by subscription flow) ──────────────────
// Returns marketer info if code is valid, 404 if not
export const validateReferralCode = async (req, res) => {
  try {
    const { code } = req.params;

    const marketer = await findMarketerByCode(code);
    if (!marketer) {
      return res
        .status(404)
        .json({ valid: false, message: "Invalid referral code" });
    }

    res.status(200).json({
      valid: true,
      marketer: { name: marketer.name, referralCode: marketer.referralCode },
    });
  } catch (error) {
    res.status(500).json({ message: "Validation failed" });
  }
};

// ── UPDATE PAYOUT DETAILS ──────────────────────────────────────────────────
export const updatePayoutDetails = async (req, res) => {
  try {
    const { payoutMethod, accountName, accountNumber, bankOrNetwork } =
      req.body;

    await Marketer.findByIdAndUpdate(req.marketer.marketerId, {
      payoutMethod,
      payoutDetails: { accountName, accountNumber, bankOrNetwork },
    });

    res.status(200).json({ message: "Payout details updated" });
  } catch (error) {
    res.status(500).json({ message: "Update failed" });
  }
};

// ── Shared helper: find marketer by referral code (Redis → DB) ─────────────
export async function findMarketerByCode(code) {
  const upper = code.toUpperCase();

  // 1. Check Redis cache first (fast path)
  const cachedId = await getReferralCode(upper);
  if (cachedId) {
    return Marketer.findById(cachedId).select("-password");
  }

  // 2. Fall back to DB and re-warm cache
  const marketer = await Marketer.findOne({
    referralCode: upper,
    isActive: true,
  });
  if (marketer) {
    await cacheReferralCode(upper, marketer._id);
  }

  return marketer;
}

// ── Serializer ────────────────────────────────────────────────────────────
function serializeMarketer(m) {
  return {
    _id: m._id,
    name: m.name,
    email: m.email,
    phone: m.phone,
    referralCode: m.referralCode,
    totalReferrals: m.totalReferrals,
    activeReferrals: m.activeReferrals,
    totalEarningsGHS: m.totalEarningsGHS,
    totalEarningsNGN: m.totalEarningsNGN,
    pendingPayoutGHS: m.pendingPayoutGHS,
    pendingPayoutNGN: m.pendingPayoutNGN,
    payoutMethod: m.payoutMethod,
    isActive: m.isActive,
    createdAt: m.createdAt,
  };
}
