import User from "../models/user.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../utils/generateTokens.js";

// REGISTER (so user will be a Guest initially, and later be upgraded to a vendor upon his subscription)
export const register = async (req, res) => {
  try {
    const { username, email, password, phone, country } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({
        message: "Required fields missing",
      });
    }

    // Check if email or username already exists
    const existingUser = await User.findOne({
      $or: [{ email }, { username }],
    });

    if (existingUser) {
      return res.status(400).json({
        message: "Email or username already in use",
      });
    }

    // 🔐 HASH PASSWORD HERE
    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await User.create({
      username,
      email,
      password: hashedPassword,
      phone,
      country,
      ipAddress: req.ip,
      role: "guest",
    });

    res.status(201).json({
      message: "Registration successful",
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
      },
    });
  } catch (error) {
    console.log("REGISTER ERROR:", error);
    res.status(500).json({
      message: error.message,
    });
  }
};

//  LOGIN, this will work for both registered and guest users for their logins into the system
export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({
        message: "Invalid credentials",
      });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({
        message: "Invalid credentials",
      });
    }

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
      user: {
        id: user._id,
        role: user.role,
        isSubscribed: user.isSubscribed,
      },
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
export const refresh = (req, res) => {
  const token = req.cookies.refreshToken;

  if (!token) {
    return res.status(401).json({
      message: "No refresh token",
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);

    const accessToken = jwt.sign(
      { userId: decoded.userId },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: "1d" },
    );

    res.cookie("accessToken", accessToken, {
      httpOnly: true,
      sameSite: "strict",
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
