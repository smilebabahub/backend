import User from "../models/user.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import { sendRegistrationEmails } from "../lib/emailService.js";
import { validateEmail } from "../lib/validateEmail.js";
import { blacklistToken } from "../lib/redis.js";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../utils/generateTokens.js";
import axios from "axios";

// ── Real IP + Country resolution ───────────────────────────────────────────
// Cloudflare sets two headers we can use directly — no Geoapify call needed:
//   cf-connecting-ip  → the real visitor IP
//   cf-ipcountry      → 2-letter ISO country code (e.g. "NG", "GH", "US")
//
// cf-ipcountry is FREE on all Cloudflare plans and is always accurate.
// Using it eliminates the Geoapify dependency for country detection entirely.
// Geoapify is still used for city/location details at registration/login.

function resolveClientIP(req) {
  const cf = req.headers["cf-connecting-ip"];
  if (cf && isPublicIP(cf)) return cf.trim();

  const xri = req.headers["x-real-ip"];
  if (xri && isPublicIP(xri)) return xri.trim();

  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first && isPublicIP(first)) return first;
  }

  return req.socket?.remoteAddress ?? "";
}

// Resolve country directly from Cloudflare's cf-ipcountry header.
// Returns { country, currency, symbol } — no external API call, instant.
function resolveCountryFromCF(req) {
  const code = (req.headers["cf-ipcountry"] ?? "").toUpperCase().trim();

  // Map ISO country codes to our supported markets
  const countryMap = {
    NG: { country: "Nigeria", currency: "NGN", symbol: "₦" },
    GH: { country: "Ghana", currency: "GHS", symbol: "₵" },
  };

  if (countryMap[code]) {
    return { ...countryMap[code], detected: true, detectedFrom: `cf:${code}` };
  }

  // Unknown country (not NG or GH) — default to Ghana
  // detected: false so frontend doesn't cache this as confirmed
  return {
    country: "Ghana",
    currency: "GHS",
    symbol: "₵",
    detected: false,
    detectedFrom: code || "unknown",
  };
}

function isPublicIP(ip) {
  if (!ip) return false;
  if (ip === "::1" || ip === "127.0.0.1") return false;
  if (/^10\./.test(ip)) return false;
  if (/^192\.168\./.test(ip)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  return true;
}

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
// ── Admin email list ───────────────────────────────────────────────────────
// Comma-separated in .env: ADMIN_EMAILS=ceo@smilebabahub.com,admin@smilebabahub.com
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

const isAdminEmail = (email = "") => ADMIN_EMAILS.has(email.toLowerCase());

// serializeUser — builds the user object sent to the frontend.
// liveCountry: pass the country resolved from cf-ipcountry on this request.
//   This ensures logged-in Nigerian users always get NGN even if their DB
//   loginHistory stored "Ghana" during a previous bad geo detection.
const serializeUser = (user, liveCountry) => {
  const obj = user.toObject ? user.toObject() : user;
  const lastLogin = obj.loginHistory?.[obj.loginHistory.length - 1];
  const admin = isAdminEmail(obj.email);

  // Country priority: explicit override > live request > DB stored > fallback
  const rawCountry = liveCountry ?? lastLogin?.country ?? obj.country ?? "";
  const country = rawCountry.toLowerCase().includes("nigeria")
    ? "Nigeria"
    : rawCountry.toLowerCase().includes("ghana")
      ? "Ghana"
      : rawCountry || "Ghana";

  const { currency, symbol, locale } = getCurrencyFromCountry(country);

  // Subscription: read from nested object, normalise active status
  const sub = obj.subscription ?? null;
  const subActive = sub?.expiresAt
    ? new Date(sub.expiresAt) > new Date()
    : false;

  return {
    // ── Auth ──────────────────────────────────────────────────────────────
    _id: obj._id,
    username: obj.username,
    email: obj.email,
    phone: obj.phone,
    role: admin ? "admin" : obj.role,
    isAdmin: admin,

    // ── Profile ───────────────────────────────────────────────────────────
    profilePicture: obj.profilePicture ?? "",
    gender: obj.gender ?? "",
    dateOfBirth: obj.dateOfBirth ?? "",
    bio: obj.bio ?? "",
    city: obj.city ?? "",
    state: obj.state ?? "",
    country,
    currency,
    symbol,
    locale,
    detectedCountry: lastLogin?.country ?? "",

    // ── Store ─────────────────────────────────────────────────────────────
    storeName: obj.storeName ?? "",
    storeSlug: obj.storeSlug ?? "",
    storeCategory: obj.storeCategory ?? "",
    storeDescription: obj.storeDescription ?? "",
    storeEmail: obj.storeEmail ?? "",
    storeWebsite: obj.storeWebsite ?? "",
    storePhone: obj.storePhone ?? "",
    storeBanner: obj.storeBanner ?? "",
    storeLogo: obj.storeLogo ?? "",
    businessType: obj.businessType ?? "individual",

    // ── Social ────────────────────────────────────────────────────────────
    instagram: obj.instagram ?? "",
    facebook: obj.facebook ?? "",
    whatsapp: obj.whatsapp ?? "",

    // ── Store policies ────────────────────────────────────────────────────
    returnPolicy: obj.returnPolicy ?? "",
    deliveryPolicy: obj.deliveryPolicy ?? "",
    exchangePolicy: obj.exchangePolicy ?? "",

    // ── Operating hours ───────────────────────────────────────────────────
    operatingHours: obj.operatingHours ?? {},

    // ── Subscription ──────────────────────────────────────────────────────
    subscription: sub,
    isSubscribed: subActive,

    // ── Payout / payments ─────────────────────────────────────────────────
    payoutMethod: obj.payoutMethod ?? "momo",
    momoDetails: obj.momoDetails ?? {},
    bankDetails: obj.bankDetails ?? {},
    taxInfo: obj.taxInfo ?? {},
    payoutSchedule: obj.payoutSchedule ?? {},

    // ── Shipping ──────────────────────────────────────────────────────────
    deliveryZones: obj.deliveryZones ?? [],
    deliveryPricing: obj.deliveryPricing ?? {},
    dispatchTime: obj.dispatchTime ?? "24",
    packagingNotes: obj.packagingNotes ?? "",

    // ── KYC ───────────────────────────────────────────────────────────────
    kycStatus: obj.kycStatus ?? {},
    kycDocType: obj.kycDocType ?? "",
    kycDocNumber: obj.kycDocNumber ?? "",
    kycDocExpiry: obj.kycDocExpiry ?? "",
    kycFrontUrl: obj.kycFrontUrl ?? "",
    kycBackUrl: obj.kycBackUrl ?? "",
    kycBizUrl: obj.kycBizUrl ?? "",
    kycBizRegNo: obj.kycBizRegNo ?? "",

    // ── Notifications ─────────────────────────────────────────────────────
    notifications: obj.notifications ?? {},

    // ── Misc ──────────────────────────────────────────────────────────────
    cartItems: obj.cartItems ?? [],
  };
};

// ── IP → Geolocation ───────────────────────────────────────────────────────
const getLocationFromIP = async (ip) => {
  try {
    const response = await axios.get(
      `https://api.geoapify.com/v1/ipinfo?ip=${ip}&apiKey=${process.env.GEOAPIFY_API_KEY}`,
      { timeout: 4000 }, // 4s max — never block the response waiting for geo
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
      return res.status(400).json({ message: "All fields are required" });
    }

    // Validate email — format, disposable domain, DNS MX record
    const emailCheck = await validateEmail(email);
    if (!emailCheck.valid) {
      return res.status(400).json({ message: emailCheck.reason });
    }

    // Block duplicate emails early (before hashing password)
    const existing = await User.findOne({
      email: email.trim().toLowerCase(),
    }).lean();
    if (existing) {
      return res
        .status(409)
        .json({ message: "An account with this email already exists" });
    }

    const ip = resolveClientIP(req);
    const geoData = await getLocationFromIP(ip);
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      username,
      email,
      password: hashedPassword,
      phone,
      role: isAdminEmail(email) ? "admin" : "guest",
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
      user: serializeUser(user, resolveCountryFromCF(req).country),
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

    // Use cf-ipcountry for instant reliable country detection (no Geoapify call)
    // Still call Geoapify for city/location detail in loginHistory (non-blocking)
    const { country: liveCountry } = resolveCountryFromCF(req);
    const ip = resolveClientIP(req);

    // Sync admin role if needed
    if (isAdminEmail(user.email) && user.role !== "admin") {
      await User.updateOne({ _id: user._id }, { role: "admin" });
    }

    // Push login event — fire geo lookup non-blocking so login is fast
    const geoPromise = getLocationFromIP(ip).catch(() => ({}));

    await User.updateOne(
      { _id: user._id },
      {
        $push: {
          loginHistory: {
            ip,
            country: liveCountry, // use CF country — reliable
            city: "detecting…",
            location: "detecting…",
            userAgent: req.headers["user-agent"],
          },
        },
      },
    );

    // Update city/location after geo resolves (non-blocking, best-effort)
    geoPromise.then(async (geoData) => {
      if (geoData?.city) {
        await User.updateOne(
          { _id: user._id, "loginHistory.ip": ip },
          {
            $set: {
              "loginHistory.$.city": geoData.city || liveCountry,
              "loginHistory.$.location": geoData.location || liveCountry,
            },
          },
        ).catch(() => {});
      }
    });

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

    // Pass liveCountry so Nigerians get NGN even if DB has wrong country stored
    res.status(200).json({
      message: "Login successful",
      accessToken,
      user: serializeUser(updatedUser, liveCountry),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};

// ── GET CURRENT USER (/auth/me) ────────────────────────────────────────────
// Called by restoreSession after refresh — must return same shape as login.
// Uses cf-ipcountry for live country so Nigerian users always get NGN.
export const getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const { country: liveCountry } = resolveCountryFromCF(req);
    res.status(200).json({ user: serializeUser(user, liveCountry) });
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

    // Blacklist the current access token so it can't be reused
    // even if someone saved it before logout (belt-and-suspenders security)
    const headerToken = req.headers.authorization?.split(" ")[1];
    const cookieToken = req.cookies?.accessToken;
    const token = headerToken ?? cookieToken;

    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_ACCESS_SECRET);
        // jti may or may not be present depending on generateAccessToken version
        // If no jti, use userId+iat as a unique key
        const key = decoded.jti ?? `${decoded.userId}:${decoded.iat}`;
        const expiresIn = (decoded.exp ?? 0) - Math.floor(Date.now() / 1000);
        if (expiresIn > 0) {
          await blacklistToken(key, expiresIn);
        }
      } catch {
        // Token already expired or invalid — no need to blacklist
      }
    }

    res.clearCookie("accessToken", opts);
    res.clearCookie("refreshToken", opts);
    res.json({ message: "Logged out successfully" });
  } catch (error) {
    console.error("logout error:", error);
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
    const ip = resolveClientIP(req);

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
// Uses Cloudflare's cf-ipcountry header — instant, free, always accurate.
// No Geoapify call needed. Falls back to Ghana only if not behind Cloudflare.
export const getGuestCountry = async (req, res) => {
  const result = resolveCountryFromCF(req);
  res.json(result);
};

// ── ADMIN: SWITCH COUNTRY VIEW ──────────────────────────────────────────────
// PATCH /auth/admin/country
// Admins call this when they toggle the country dropdown.
// Returns a fresh user object with the selected country/currency applied.
// The country is NOT persisted to DB — it's a session-level preference
// stored in Redux (adminViewCountry).
export const adminSwitchCountry = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select(
      "email role loginHistory",
    );
    if (!user || !isAdminEmail(user.email)) {
      return res.status(403).json({ message: "Admin access required" });
    }

    const { country } = req.body;
    const allowed = ["Ghana", "Nigeria"];
    if (!allowed.includes(country)) {
      return res
        .status(400)
        .json({ message: "Country must be 'Ghana' or 'Nigeria'" });
    }

    res.status(200).json({
      user: serializeUser(user, country),
      adminViewCountry: country,
    });
  } catch (error) {
    console.error("adminSwitchCountry error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ── PATCH /auth/profile — update user profile ─────────────────────────────
export const updateProfile = async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      // Personal profile
      username,
      phone,
      city,
      state,
      bio,
      gender,
      dateOfBirth,
      profilePicture, // ← Cloudinary URL from avatar upload
      // Store identity
      storeName,
      storeSlug,
      storeCategory,
      storeDescription,
      storeEmail,
      storeWebsite,
      storePhone,
      businessType,
      storeBanner,
      storeLogo, // ← Cloudinary URLs from StoreTab
      // Social
      instagram,
      facebook,
      whatsapp,
      // Store policies
      returnPolicy,
      deliveryPolicy,
      exchangePolicy,
      // Operating hours (full object from StoreTab)
      operatingHours,
      // KYC fields (from KycTab)
      kycDocType,
      kycDocNumber,
      kycDocExpiry,
      kycFrontUrl,
      kycBackUrl,
      kycBizUrl,
      kycBizRegNo,
    } = req.body;

    const allowed = {
      username,
      phone,
      city,
      state,
      bio,
      gender,
      dateOfBirth,
      profilePicture,
      storeName,
      storeSlug,
      storeCategory,
      storeDescription,
      storeEmail,
      storeWebsite,
      storePhone,
      businessType,
      storeBanner,
      storeLogo,
      instagram,
      facebook,
      whatsapp,
      returnPolicy,
      deliveryPolicy,
      exchangePolicy,
      operatingHours,
      kycDocType,
      kycDocNumber,
      kycDocExpiry,
      kycFrontUrl,
      kycBackUrl,
      kycBizUrl,
      kycBizRegNo,
    };

    // Remove undefined so we never overwrite existing values with undefined
    Object.keys(allowed).forEach((k) => {
      if (allowed[k] === undefined) delete allowed[k];
    });

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: allowed },
      { new: true, runValidators: false }, // runValidators:false — partial update safe
    ).select("-password -loginHistory");

    if (!user) return res.status(404).json({ message: "User not found" });

    res
      .status(200)
      .json({ message: "Profile updated", user: serializeUser(user) });
  } catch (err) {
    console.error("updateProfile error:", err);
    res.status(500).json({ message: "Failed to update profile" });
  }
};

// ── PATCH /auth/password — change password ─────────────────────────────────
export const changePassword = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Both passwords are required" });
    }
    if (newPassword.length < 8) {
      return res
        .status(400)
        .json({ message: "New password must be at least 8 characters" });
    }

    const user = await User.findById(userId).select("password");
    if (!user) return res.status(404).json({ message: "User not found" });

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match)
      return res.status(401).json({ message: "Current password is incorrect" });

    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();

    res.status(200).json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("changePassword error:", err);
    res.status(500).json({ message: "Failed to change password" });
  }
};

// ── PATCH /auth/notifications — save notification preferences ──────────────
export const updateNotifications = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { notifications } = req.body;

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { notifications } },
      { new: true },
    ).select("-password -loginHistory");
    if (!user) return res.status(404).json({ message: "User not found" });

    res
      .status(200)
      .json({
        message: "Notification preferences saved",
        user: serializeUser(user),
      });
  } catch (err) {
    res.status(500).json({ message: "Failed to save notifications" });
  }
};

// ── PATCH /auth/payment-details — save payout info ────────────────────────
export const updatePaymentDetails = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { payoutMethod, momoDetails, bankDetails, taxInfo, payoutSchedule } =
      req.body;

    const user = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          payoutMethod,
          momoDetails,
          bankDetails,
          taxInfo,
          payoutSchedule,
        },
      },
      { new: true },
    ).select("-password -loginHistory");
    if (!user) return res.status(404).json({ message: "User not found" });

    res
      .status(200)
      .json({ message: "Payment details saved", user: serializeUser(user) });
  } catch (err) {
    res.status(500).json({ message: "Failed to save payment details" });
  }
};

// ── PATCH /auth/shipping — save shipping settings ──────────────────────────
export const updateShipping = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { deliveryZones, deliveryPricing, dispatchTime, packagingNotes } =
      req.body;

    const user = await User.findByIdAndUpdate(
      userId,
      {
        $set: { deliveryZones, deliveryPricing, dispatchTime, packagingNotes },
      },
      { new: true },
    ).select("-password -loginHistory");
    if (!user) return res.status(404).json({ message: "User not found" });

    res
      .status(200)
      .json({ message: "Shipping settings saved", user: serializeUser(user) });
  } catch (err) {
    res.status(500).json({ message: "Failed to save shipping settings" });
  }
};

// ── POST /auth/promotion — submit promotional video campaign ───────────────
export const submitPromotion = async (req, res) => {
  try {
    const userId = req.user.userId;
    const {
      title,
      description,
      category,
      promotionType,
      targetRegion,
      targetAudience,
      startDate,
      endDate,
      budget,
      currency,
      contactName,
      contactPhone,
      contactEmail,
      preferredContact,
      videoUrl,
      videoName,
    } = req.body;

    if (!title || !videoUrl || !contactName) {
      return res
        .status(400)
        .json({ message: "Title, video URL and contact name are required" });
    }

    const user = await User.findById(userId)
      .select("username email storeName")
      .lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    // Store promotion record on user document
    await User.findByIdAndUpdate(userId, {
      $push: {
        promotions: {
          title,
          description,
          category,
          promotionType,
          targetRegion,
          targetAudience,
          startDate,
          endDate,
          budget,
          currency,
          contactName,
          contactPhone,
          contactEmail,
          preferredContact,
          videoUrl,
          videoName,
          status: "pending",
          submittedAt: new Date(),
        },
      },
    });

    // Email admin team
    const { sendAdminDirectEmail } = await import("../lib/emailService.js");
    const adminEmail = process.env.ADMIN_EMAIL || process.env.EMAIL_USER;
    if (adminEmail) {
      await sendAdminDirectEmail({
        to: adminEmail,
        name: "SmileBaba Admin",
        subject: `New Promotion Submission — ${title}`,
        message: `
Vendor: ${user.storeName ?? user.username} (${user.email})
Campaign: ${title}
Category: ${category}
Region: ${targetRegion}
Contact: ${contactName} · ${contactPhone} · ${contactEmail}
Budget: ${currency} ${budget || "Not specified"}
Preferred contact: ${preferredContact}

Video: ${videoUrl}

Description:
${description}
        `.trim(),
      });
    }

    res
      .status(201)
      .json({
        message:
          "Promotion submitted successfully. We will review and contact you within 2–3 business days.",
      });
  } catch (err) {
    console.error("submitPromotion error:", err);
    res.status(500).json({ message: "Failed to submit promotion" });
  }
};
