// models/marketer.js
import mongoose from "mongoose";

const commissionSchema = new mongoose.Schema(
  {
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    planId: { type: String, required: true },
    billingCycle: { type: String, required: true },
    originalAmount: { type: Number, required: true }, // full price before discount
    discountAmount: { type: Number, required: true }, // 20% off given to vendor
    commission: { type: Number, required: true }, // marketer earns 20% of original
    currency: { type: String, required: true },
    txRef: { type: String, required: true },
    paidOut: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const marketerSchema = new mongoose.Schema(
  {
    // ── Identity ──────────────────────────────────────────────────────────
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: { type: String, required: true },
    password: { type: String, required: true },

    // ── Referral ──────────────────────────────────────────────────────────
    referralCode: {
      type: String,
      unique: true,
      uppercase: true,
      // Generated on save — e.g. "SMB-KWAME-4X9Z"
    },

    // ── Stats ─────────────────────────────────────────────────────────────
    totalReferrals: { type: Number, default: 0 }, // vendors who used the code
    activeReferrals: { type: Number, default: 0 }, // vendors with active subscriptions
    totalEarningsGHS: { type: Number, default: 0 },
    totalEarningsNGN: { type: Number, default: 0 },
    pendingPayoutGHS: { type: Number, default: 0 },
    pendingPayoutNGN: { type: Number, default: 0 },

    // ── Commission history ─────────────────────────────────────────────────
    commissions: [commissionSchema],

    // ── Payout details ─────────────────────────────────────────────────────
    payoutMethod: {
      type: String,
      enum: ["momo", "bank", ""],
      default: "",
    },
    payoutDetails: {
      accountName: { type: String, default: "" },
      accountNumber: { type: String, default: "" },
      bankOrNetwork: { type: String, default: "" },
    },

    isActive: { type: Boolean, default: true },
    lastLogin: { type: Date, default: null },
  },
  { timestamps: true },
);

// ── Auto-generate referral code before first save ──────────────────────────
marketerSchema.pre("save", async function () {
  if (this.referralCode) return; // already set — nothing to do

  const base = this.name
    .split(" ")[0]
    .toUpperCase()
    .replace(/[^A-Z]/g, "")
    .slice(0, 6);
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  this.referralCode = `SMB-${base}-${random}`;
});

const Marketer =
  mongoose.models.Marketer || mongoose.model("Marketer", marketerSchema);

export default Marketer;
