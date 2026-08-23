// backend/routes/waitlist.js
//
// Minimal waitlist collection for product launches (Money, others later).
// Follows the same patterns as your existing routes — authenticate for
// admin GET, public POST.
//
// Mount in server.js:
//   import waitlistRoutes from "./routes/waitlist.js";
//   app.use("/smilebaba/waitlist", waitlistRoutes);

import express from "express";
import mongoose from "mongoose";
// Adjust paths to your project structure
import { authenticate } from "../middleware/authMiddleWare.js";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = express.Router();

// ─── Waitlist schema (defined inline — small enough) ────────────────
const waitlistSchema = new mongoose.Schema(
  {
    product: {
      type: String,
      required: true,
      enum: ["money", "vendor-tools", "loans"], // extend later
      index: true,
    },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    country: { type: String, enum: ["Ghana", "Nigeria"] },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    status: {
      type: String,
      enum: ["waiting", "contacted", "onboarded"],
      default: "waiting",
    },
    notes: String,
  },
  { timestamps: true },
);

// Prevent duplicate phone for the same product
waitlistSchema.index({ product: 1, phone: 1 }, { unique: true });

const Waitlist =
  mongoose.models.Waitlist || mongoose.model("Waitlist", waitlistSchema);

// ═══════════════════════════════════════════════════════════════════════
// POST /waitlist — public. Anyone can join.
// ═══════════════════════════════════════════════════════════════════════
router.post("/", async (req, res) => {
  try {
    const { product, name, phone, email, country, userId } = req.body;

    if (!product || !name || !phone) {
      return res
        .status(400)
        .json({ message: "product, name and phone are required" });
    }

    // Try to attach userId if the request has an authenticated session
    let attachedUserId;
    try {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        // Optionally decode without failing hard
        // Left to the middleware if you want authenticated-only vs public
      }
    } catch {
      /* ignore */
    }

    // Upsert-friendly: if same phone + product exists, return existing
    const existing = await Waitlist.findOne({ product, phone: phone.trim() });
    if (existing) {
      return res.json({
        message: "You're already on the list",
        entry: existing,
      });
    }

    const entry = await Waitlist.create({
      product,
      name: name.trim(),
      phone: phone.trim(),
      email: email?.trim() || undefined,
      country,
      userId: attachedUserId || userId || undefined,
    });

    return res.status(201).json({
      message: "You're on the waitlist",
      entry,
    });
  } catch (err) {
    // Handle unique index violation gracefully
    if (err.code === 11000) {
      return res.json({ message: "You're already on the list" });
    }
    console.error("[waitlist POST]", err);
    return res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// GET /waitlist — admin only. List entries with filters + pagination.
// Query: ?product=money&status=waiting&search=name&page=1&limit=50
// ═══════════════════════════════════════════════════════════════════════
router.get("/", authenticate, requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.product) filter.product = req.query.product;
    if (req.query.status) filter.status = req.query.status;
    if (req.query.country) filter.country = req.query.country;
    if (req.query.search) {
      const rx = new RegExp(req.query.search, "i");
      filter.$or = [{ name: rx }, { phone: rx }, { email: rx }];
    }

    const [entries, total, byProduct, byCountry] = await Promise.all([
      Waitlist.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Waitlist.countDocuments(filter),
      Waitlist.aggregate([{ $group: { _id: "$product", count: { $sum: 1 } } }]),
      Waitlist.aggregate([{ $group: { _id: "$country", count: { $sum: 1 } } }]),
    ]);

    res.json({
      entries,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      stats: {
        byProduct: byProduct.reduce(
          (acc, r) => ({ ...acc, [r._id]: r.count }),
          {},
        ),
        byCountry: byCountry.reduce(
          (acc, r) => ({ ...acc, [r._id ?? "unknown"]: r.count }),
          {},
        ),
      },
    });
  } catch (err) {
    console.error("[waitlist GET]", err);
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// PATCH /waitlist/:id — admin only. Update status/notes.
// ═══════════════════════════════════════════════════════════════════════
router.patch("/:id", authenticate, requireAdmin, async (req, res) => {
  try {
    const { status, notes } = req.body;
    const entry = await Waitlist.findByIdAndUpdate(
      req.params.id,
      {
        $set: {
          ...(status && { status }),
          ...(notes !== undefined && { notes }),
        },
      },
      { new: true },
    );
    if (!entry) return res.status(404).json({ message: "Entry not found" });
    res.json({ entry });
  } catch (err) {
    console.error("[waitlist PATCH]", err);
    res.status(500).json({ message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// DELETE /waitlist/:id — admin only.
// ═══════════════════════════════════════════════════════════════════════
router.delete("/:id", authenticate, requireAdmin, async (req, res) => {
  try {
    await Waitlist.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error("[waitlist DELETE]", err);
    res.status(500).json({ message: err.message });
  }
});

export default router;
