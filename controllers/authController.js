import User from "../models/user.js";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import nodemailer from "nodemailer";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../utils/generateTokens.js";

import axios from "axios";
import user from "../models/user.js";

const getLocationFromIP = async (ip) => {
  try {
    const response = await axios.get(
      `https://api.geoapify.com/v1/ipinfo?ip=${ip}&apiKey=${process.env.GEOAPIFY_API_KEY}`,
    );

    return {
      country: response.data.country?.name || "",
      city: response.data.city?.name || "",
      location:
        response.data.city?.name + ", " + response.data.country?.name || "",
    };
  } catch (error) {
    console.log("Geoapify error:", error.message);
    return {
      country: "",
      city: "",
      location: "",
    };
  }
};

// REGISTER (so user will be a Guest initially, and later be upgraded to a vendor upon his subscription)
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
    res.status(201).json(user);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

//  LOGIN, this will work for both registered and guest users for their logins into the system
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res
        .status(400)
        .json({ message: "Incorrect username and password" });
    }

    const ip =
      req.headers["x-forwarded-for"]?.split(",").shift() ||
      req.socket?.remoteAddress;

    const geoData = await getLocationFromIP(ip);

    user.loginHistory.push({
      ip,
      country: geoData.country,
      city: geoData.city,
      location: geoData.location,
      userAgent: req.headers["user-agent"],
    });

    await user.save();

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    res.cookie("accessToken", accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.cookie("refreshToken", refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      message: "Login successful",
      accessToken: accessToken,
      user,
    });
  } catch (error) {
    res.status(500).json({
      message: "Server error",
    });
  }
};

// Our logout logic lies here.
export const logout = (req, res) => {
  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");

  res.json({
    message: "Logged out successfully",
  });
};

// REFRESH TOKEN, to renew the access tokens when they expires
export const refresh = async (req, res) => {
  const token = req.cookies.refreshToken;

  if (!token) {
    return res.status(401).json({
      message: "No refresh token",
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);

    const user = await User.findById(decoded.userId);

    if (!user) {
      return res.status(401).json({
        message: "User no longer exists",
      });
    }

    const accessToken = generateAccessToken(user);

    res.cookie("accessToken", accessToken, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
    });

    res.json({
      message: "Token refreshed",
    });
  } catch (error) {
    res.status(403).json({
      message: "Invalid refresh token",
    });
  }
};

export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    const findUser = await User.findOne({ email });
    if (!findUser) {
      return res.status(404).json({ message: "user not found" });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");

    findUser.passwordResetToken = hashedToken;
    findUser.passwordResetExpires = Date.now() + 10 * 60 * 1000;

    await findUser.save();

    // Create reset URL (frontend handles this)
    const resetURL = `http://localhost:3000/reset-password/${resetToken}`;

    // Send email
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
      tls: {
        rejectUnauthorized: false,
      },
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

//reset Password

export const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    // Hash the token to compare with database
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ message: "Token is invalid or expired" });
    }

    // Hash new password
    user.password = await bcrypt.hash(password, 10);

    // Clear reset token and expiry
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;

    await user.save();

    res.json({ message: "Password reset successful" });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Server error" });
  }
};
