import User from "../models/user.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import { sendRegistrationEmails } from "../lib/emailService.js";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../utils/generateTokens.js";
import axios from "axios";

// ── Currency helper ────────────────────────────────────────────────────────
// Extend this map as you expand to more countries
const getCurrencyFromCountry = (country = "") => {
  const c = country.toLowerCase();
  if (c.includes("ghana"))
    return { currency: "GHS", symbol: "₵", locale: "en-GH" };
  if (c.includes("nigeria"))
    return { currency: "NGN", symbol: "₦", locale: "en-NG" };
  // Default fallback
  return { currency: "GHS", symbol: "₵", locale: "en-GH" };
};

// ── Shared user serializer ─────────────────────────────────────────────────
// Single place that decides what fields go to the frontend — keeps login,
// refresh, and /me responses consistent so Redux never gets mismatched shapes
const serializeUser = (user) => {
  const lastLogin = user.loginHistory?.[user.loginHistory.length - 1];
  const country = lastLogin?.country ?? "";
  const { currency, symbol, locale } = getCurrencyFromCountry(country);

  return {
    _id: user._id,
    username: user.username,
    email: user.email,
    phone: user.phone,
    role: user.role,
    city: user.city,
    state: user.state,
    profilePicture: user.profilePicture,
    cartItems: user.cartItems,
    subscription: user.subscription ?? null,
    // ── Geo / currency ──
    country,
    currency, // "GHS" | "NGN"
    symbol, // "₵"   | "₦"
    locale, // "en-GH" | "en-NG"
  };
};

// ── IP → Geolocation ───────────────────────────────────────────────────────
const getLocationFromIP = async (ip) => {
  try {
    const response = await axios.get(
      `https://api.geoapify.com/v1/ipinfo?ip=${ip}&apiKey=${process.env.GEOAPIFY_API_KEY}`,
    );
    return {
      country: response.data.country?.name || "",
      city: response.data.city?.name || "",
      location:
        `${response.data.city?.name}, ${response.data.country?.name}` || "",
    };
  } catch (error) {
    console.log("Geoapify error:", error.message);
    return { country: "", city: "", location: "" };
  }
};

// ── Cookie options helper ──────────────────────────────────────────────────
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
export const register = async (req, res) => {
  try {
    const { username, email, password, phone } = req.body;

    if (!username || !email || !password || !phone) {
      return res.status(400).json({ message: "Required fields missing" });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",").shift() ||
      req.socket?.remoteAddress;
    const geoData = await getLocationFromIP(ip);
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      username,
      email,
      password: hashedPassword,
      phone,
      loginHistory: [
        {
          ip,
          country: geoData.country,
          city: geoData.city,
          location: geoData.location,
          userAgent: req.headers["user-agent"],
        },
      ],
    });

    res.status(200).json({
      message: "Registration successful",
      user: serializeUser(user),
    });

    // Send welcome emails (fire-and-forget — never blocks the response)
    sendRegistrationEmails({
      username: user.username,
      email: user.email,
      country: geoData.country,
      city: geoData.city,
    }).catch((e) => console.error("[register] email error:", e.message));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── LOGIN ──────────────────────────────────────────────────────────────────
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res
        .status(400)
        .json({ message: "Incorrect username and password" });

    const ip =
      req.headers["x-forwarded-for"]?.split(",").shift() ||
      req.socket?.remoteAddress;
    const geoData = await getLocationFromIP(ip);

    // Push new login event — this becomes the "last login" used for currency
    await User.updateOne(
      { _id: user._id },
      {
        $push: {
          loginHistory: {
            ip,
            country: geoData?.country || "Unknown",
            city: geoData?.city || "Unknown",
            location: geoData?.location || "Unknown",
            userAgent: req.headers["user-agent"],
          },
        },
      },
    );

    // Reload user so loginHistory includes the entry we just pushed
    const updatedUser = await User.findById(user._id);

    const accessToken = generateAccessToken(updatedUser);
    const refreshToken = generateRefreshToken(updatedUser);
    const opts = cookieOptions();

    res.cookie("accessToken", accessToken, {
      ...opts,
      maxAge: 24 * 60 * 60 * 1000,
    });
    res.cookie("refreshToken", refreshToken, {
      ...opts,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      message: "Login successful",
      accessToken,
      user: serializeUser(updatedUser),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// ── GET CURRENT USER (/auth/me) ────────────────────────────────────────────
// Called by restoreSession after refresh — must return same shape as login
export const getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);

    if (!user) return res.status(404).json({ message: "User not found" });

    res.status(200).json({ user: serializeUser(user) });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

// ── REFRESH TOKEN ──────────────────────────────────────────────────────────
export const refresh = async (req, res) => {
  const token = req.cookies.refreshToken;
  if (!token) return res.status(401).json({ message: "No refresh token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const user = await User.findById(decoded.userId);

    if (!user)
      return res.status(401).json({ message: "User no longer exists" });

    const accessToken = generateAccessToken(user);
    const opts = cookieOptions();

    res.cookie("accessToken", accessToken, {
      ...opts,
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({ accessToken, message: "Token refreshed" });
  } catch (error) {
    return res.status(403).json({ message: "Invalid refresh token" });
  }
};

// ── LOGOUT ─────────────────────────────────────────────────────────────────
export const logout = async (req, res) => {
  try {
    const opts = cookieOptions();
    res.clearCookie("accessToken", opts);
    res.clearCookie("refreshToken", opts);
    res.json({ message: "Logged out successfully" });
  } catch (error) {
    res.status(500).json({ message: "Server error" });
  }
};

// ── FORGOT PASSWORD ────────────────────────────────────────────────────────
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    const findUser = await User.findOne({ email });

    if (!findUser) return res.status(404).json({ message: "User not found" });

    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    findUser.passwordResetToken = hashedToken;
    findUser.passwordResetExpires = Date.now() + 10 * 60 * 1000;
    await findUser.save();

    const resetURL = `${process.env.NEXT_PUBLIC_APP_URL}/reset-password/${resetToken}`;

    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      tls: { rejectUnauthorized: false },
      family: 4,
    });

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: findUser.email,
      subject: "Password Reset Request",
      html: `<p>Click this link to reset your password: <a href="${resetURL}">${resetURL}</a></p>`,
    });

    res.json({ message: "Password reset email sent" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Server error" });
  }
};

// ── RESET PASSWORD ─────────────────────────────────────────────────────────
export const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    });

    if (!user)
      return res.status(400).json({ message: "Token is invalid or expired" });

    user.password = await bcrypt.hash(password, 10);
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    res.json({ message: "Password reset successful" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Server error" });
  }
};

// ── GUEST LOCATION — GET /auth/guest-location ──────────────────────────────
// Returns country + currency for unauthenticated visitors based on their IP.
// This proxies Geoapify so the API key is never exposed to the browser.
// Response is intentionally minimal and requires no auth.
export const getGuestLocation = async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"]?.split(",").shift() ||
      req.socket?.remoteAddress ||
      "";

    const geo = await getLocationFromIP(ip);

    // Map to supported countries — everything else defaults to Ghana
    let country = "Ghana";
    let currency = "GHS";
    let symbol = "₵";

    if (geo.country?.toLowerCase().includes("nigeria")) {
      country = "Nigeria";
      currency = "NGN";
      symbol = "₦";
    } else if (geo.country?.toLowerCase().includes("ghana")) {
      country = "Ghana";
      currency = "GHS";
      symbol = "₵";
    }

    res.json({
      country,
      currency,
      symbol,
      detectedFrom: geo.country || "unknown",
    });
  } catch (error) {
    // Always return a valid fallback — never a 500 for guests
    res.json({
      country: "Ghana",
      currency: "GHS",
      symbol: "₵",
      detectedFrom: "fallback",
    });
  }
};

// ── GUEST COUNTRY (/auth/guest-country) ───────────────────────────────────
// Called by GuestLocationDetector on app mount for unauthenticated visitors.
// Returns their country + currency from IP — no auth required.
// Response is intentionally minimal and fast (no DB write).
export const getGuestCountry = async (req, res) => {
  try {
    const ip =
      req.headers["x-forwarded-for"]?.split(",").shift() ||
      req.socket?.remoteAddress ||
      "";

    const geo = await getLocationFromIP(ip);
    const countryName = geo.country || "Ghana";

    // Map country name to currency
    const c = countryName.toLowerCase();
    let currency = "GHS";
    if (c.includes("nigeria")) currency = "NGN";

    // Normalise country name to one of our supported values
    let country = "Ghana";
    if (c.includes("nigeria")) country = "Nigeria";

    res.json({ country, currency });
  } catch {
    // Always return a safe default — never error on geo detection
    res.json({ country: "Ghana", currency: "GHS" });
  }
};
