// controllers/oauthController.js
// OAuth login via Google and Facebook.
// Flow: frontend gets ID token/access token from provider
//       → POST /auth/oauth/google or /auth/oauth/facebook
//       → we verify with the provider's API (no Passport needed)
//       → find or create user → issue our own JWT pair
//       → same cookie/response shape as normal login

import axios from "axios";
import { OAuth2Client } from "google-auth-library";
import User from "../models/user.js";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../utils/generateTokens.js";
import { sendRegistrationEmails } from "../lib/emailService.js";
import { logError } from "../lib/errorLog.js";

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// ── Inline helpers (mirrors authController.js internals) ─────────────────
const cookieOptions = () => {
  const isProd =
    process.env.NODE_ENV === "production" ||
    !!process.env.RENDER ||
    (process.env.PORT !== undefined && process.env.PORT !== "3001");
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? "none" : "lax",
    path: "/",
  };
};

// Minimal user serializer for OAuth logins
const serializeUser = (user) => ({
  _id: String(user._id),
  username: user.username ?? "",
  email: user.email ?? "",
  role: user.role ?? "guest",
  country: user.country ?? "Ghana",
  currency: user.currency ?? "GHS",
  isSubscribed: user.isSubscribed ?? false,
  subscription: user.subscription ?? null,
  phone: user.phone ?? "",
  authProvider: user.authProvider ?? "google",
  oauth: user.oauth ?? {},
});

// Best-effort country detection for OAuth users
async function resolveCountryForUser(req) {
  try {
    const cf = req.headers["cf-ipcountry"];
    if (cf && cf !== "XX") {
      return cf.toLowerCase().includes("ng") ? "Nigeria" : "Ghana";
    }
    const ip = (
      req.headers["x-forwarded-for"] ??
      req.socket?.remoteAddress ??
      ""
    )
      .split(",")[0]
      .trim();
    if (ip && ip !== "::1" && !ip.startsWith("127.")) {
      const geo = await axios.get(
        `http://ip-api.com/json/${ip}?fields=countryCode`,
        { timeout: 2000 },
      );
      const code = geo.data?.countryCode ?? "";
      if (code === "NG") return "Nigeria";
    }
  } catch {}
  return "Ghana";
}

// ── Shared: find or create an OAuth user, then issue tokens ──────────────
async function loginOrCreateOAuthUser({
  req,
  res,
  provider,
  providerId,
  email,
  name,
  picture,
  rawProfile,
}) {
  try {
    // 1. Try to find by OAuth provider ID first (most reliable)
    let user = await User.findOne({ [`oauth.${provider}.id`]: providerId });

    // 2. If not found by provider ID, try matching by email (user may have
    //    registered with email before, or used same email on another provider)
    if (!user && email) {
      user = await User.findOne({ email: email.toLowerCase() });
      if (user) {
        // Link this OAuth provider to the existing account
        await User.updateOne(
          { _id: user._id },
          {
            $set: {
              [`oauth.${provider}.id`]: providerId,
              [`oauth.${provider}.email`]: email,
              [`oauth.${provider}.picture`]: picture ?? null,
            },
          },
        );
        user = await User.findById(user._id);
      }
    }

    // 3. No existing user — create new account
    if (!user) {
      const username =
        name ||
        email?.split("@")[0]?.replace(/[^a-zA-Z0-9]/g, "") ||
        `user${Date.now()}`;

      user = await User.create({
        username,
        email: email?.toLowerCase() ?? null,
        role: "guest",
        isSubscribed: false,
        authProvider: provider,
        oauth: {
          [provider]: {
            id: providerId,
            email,
            picture: picture ?? null,
          },
        },
        // No password for OAuth users
        password: null,
      });

      // Welcome email (non-blocking)
      if (email) {
        sendRegistrationEmails({
          username: user.username,
          email,
          country: "Ghana",
          city: "",
        }).catch(() => {});
      }
    }

    // 4. Detect country from request headers (CF / IP)
    const liveCountry = await resolveCountryForUser(req).catch(
      () => user.country ?? "Ghana",
    );

    // 5. Issue JWT pair — same as normal login
    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);
    const opts = cookieOptions();

    res.cookie("accessToken", accessToken, {
      ...opts,
      maxAge: 24 * 60 * 60 * 1000,
    });
    res.cookie("refreshToken", refreshToken, {
      ...opts,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      message: "Login successful",
      accessToken,
      user: { ...serializeUser(user), country: liveCountry },
      isNewUser:
        !user.createdAt ||
        Date.now() - new Date(user.createdAt).getTime() < 5000,
    });
  } catch (err) {
    logError("oauthController", err);
    return res
      .status(500)
      .json({ message: "OAuth login failed. Please try again." });
  }
}

// ── POST /auth/oauth/google ───────────────────────────────────────────────
// Body: { idToken: string }  ← from Google Identity Services
export const googleLogin = async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken)
      return res.status(400).json({ message: "idToken is required" });

    if (!process.env.GOOGLE_CLIENT_ID) {
      return res
        .status(500)
        .json({ message: "Google OAuth is not configured" });
    }

    // Verify the ID token with Google
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    if (!payload?.sub) {
      return res.status(401).json({ message: "Invalid Google token" });
    }

    return loginOrCreateOAuthUser({
      req,
      res,
      provider: "google",
      providerId: payload.sub,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      rawProfile: payload,
    });
  } catch (err) {
    logError("googleLogin", err);
    if (
      err.message?.includes("Token used too late") ||
      err.message?.includes("Invalid token")
    ) {
      return res
        .status(401)
        .json({ message: "Google token expired or invalid" });
    }
    return res.status(500).json({ message: "Google login failed" });
  }
};

// ── POST /auth/oauth/facebook ─────────────────────────────────────────────
// Body: { accessToken: string }  ← from Facebook JS SDK
export const facebookLogin = async (req, res) => {
  try {
    const { accessToken } = req.body;
    if (!accessToken)
      return res.status(400).json({ message: "accessToken is required" });

    if (!process.env.FACEBOOK_APP_ID || !process.env.FACEBOOK_APP_SECRET) {
      return res
        .status(500)
        .json({ message: "Facebook OAuth is not configured" });
    }

    // Verify the access token with Facebook Graph API
    const [profileRes, debugRes] = await Promise.all([
      axios.get("https://graph.facebook.com/me", {
        params: {
          fields: "id,name,email,picture.type(large)",
          access_token: accessToken,
        },
      }),
      axios.get("https://graph.facebook.com/debug_token", {
        params: {
          input_token: accessToken,
          access_token: `${process.env.FACEBOOK_APP_ID}|${process.env.FACEBOOK_APP_SECRET}`,
        },
      }),
    ]);

    const debug = debugRes.data?.data;
    const profile = profileRes.data;

    // Ensure token belongs to our app and is valid
    if (!debug?.is_valid || debug.app_id !== process.env.FACEBOOK_APP_ID) {
      return res.status(401).json({ message: "Invalid Facebook token" });
    }
    if (!profile?.id) {
      return res
        .status(401)
        .json({ message: "Could not fetch Facebook profile" });
    }

    return loginOrCreateOAuthUser({
      req,
      res,
      provider: "facebook",
      providerId: profile.id,
      email: profile.email ?? null,
      name: profile.name,
      picture: profile.picture?.data?.url ?? null,
      rawProfile: profile,
    });
  } catch (err) {
    logError("facebookLogin", err);
    if (err.response?.status === 401 || err.response?.status === 400) {
      return res
        .status(401)
        .json({ message: "Facebook token invalid or expired" });
    }
    return res.status(500).json({ message: "Facebook login failed" });
  }
};
