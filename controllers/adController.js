import User from "../models/user.js";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../utils/generateTokens.js";
import jwt from "jsonwebtoken";

// REGISTER

export const register = async (req, res) => {
  try {
    const { username, email, password, phone } = req.body;

    if (!username || !email || !password || !phone) {
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

    const user = await User.create({
      username,
      email,
      password,
      phone,
      country,
      ipAddress: req.ip,
      role: "guest",
    });

    res.status(201).json({
      message: "Registration successful",
    });
  } catch (error) {
    res.status(500).json({
      message: "Server error",
    });
  }
};

// LOGIN

export const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password required",
      });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({
        message: "Invalid credentials",
      });
    }

    const isMatch = await user.comparePassword(password);

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
        username: user.username,
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

// LOGOUT
export const logout = (req, res) => {
  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");

  res.json({
    message: "Logged out successfully",
  });
};

// REFRESH TOKEN

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
