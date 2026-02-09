import User from "../models/User.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

/**
 * REGISTERED USER (with subscription)
 */
export const register = async (req, res) => {
  const { name, email, password, phone, subscription } = req.body;

  if (!name || !email || !password || !phone || !subscription) {
    return res.status(400).json({ message: "All fields required" });
  }

  const userExists = await User.findOne({ email });
  if (userExists) {
    return res.status(400).json({ message: "User already exists" });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const now = new Date();
  const expiresAt =
    subscription.billingCycle === "monthly"
      ? new Date(new Date(now).setMonth(now.getMonth() + 1))
      : new Date(new Date(now).setFullYear(now.getFullYear() + 1));

  const newUser = await User.create({
    name,
    email,
    phone,
    password: hashedPassword,
    role: "registered",
    subscription: {
      plan: subscription.plan,
      billingCycle: subscription.billingCycle,
      price: subscription.price,
      startedAt: new Date(),
      expiresAt,
    },
  });

  return res.status(201).json({
    message: "Registered successfully",
    userId: newUser._id,
  });
};

/**
 * GUEST USER (no subscription)
 */
export const createUser = async (req, res) => {
  const { name, email, password, phone } = req.body;

  if (!name || !email || !password || !phone) {
    return res.status(400).json({ message: "All fields required" });
  }

  const userExists = await User.findOne({ email });
  if (userExists) {
    return res.status(400).json({ message: "User already exists" });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const newUser = await User.create({
    name,
    email,
    phone,
    password: hashedPassword,
    role: "guest",
    subscription: null,
  });

  return res.status(201).json({
    message: "User created successfully",
    userId: newUser._id,
  });
};

/**
 * LOGIN (for both guest & registered)
 */
export const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: "Invalid credentials" });
  }

  const existingUser = await User.findOne({ email });
  if (!existingUser) {
    return res.status(400).json({ message: "User not found" });
  }

  const isPasswordCorrect = await bcrypt.compare(
    password,
    existingUser.password,
  );

  if (!isPasswordCorrect) {
    return res.status(400).json({ message: "Incorrect password" });
  }

  const accessToken = jwt.sign(
    { userId: existingUser._id, role: existingUser.role },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: "1d" },
  );

  const refreshToken = jwt.sign(
    { userId: existingUser._id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: "7d" },
  );

  res.cookie("accessToken", accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 24 * 60 * 60 * 1000,
  });

  res.cookie("refreshToken", refreshToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  return res.status(200).json({
    message: "Login successful",
    user: {
      id: existingUser._id,
      name: existingUser.name,
      email: existingUser.email,
      phone: existingUser.phone,
      role: existingUser.role,
      subscription: existingUser.subscription,
    },
  });
};

/**
 * LOGOUT
 */
export const logout = (req, res) => {
  res.clearCookie("accessToken");
  res.clearCookie("refreshToken");
  return res.json({ message: "Logged out successfully" });
};

/**
 * REFRESH TOKEN
 */
export const refresh = (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (!refreshToken) {
    return res.status(401).json({ message: "No refresh token" });
  }

  try {
    const decoded = verify(refreshToken, process.env.JWT_SECRET);

    const newAccessToken = sign(
      { userId: decoded.userId },
      process.env.JWT_ACCESS_SECRET,
      { expiresIn: "15m" },
    );

    res.cookie("accessToken", newAccessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 15 * 60 * 1000,
    });

    return res.json({ message: "Token refreshed" });
  } catch (error) {
    return res.status(403).json({ message: "Invalid refresh token" });
  }
};
