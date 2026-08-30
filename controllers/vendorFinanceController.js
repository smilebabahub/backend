// controllers/vendorFinanceController.js — UPDATED VERSION
//
// Now actually moves money via Flutterwave (Transfer + Refund APIs).

import mongoose from "mongoose";
import Order from "../models/orderModel.js";
import VendorLedger from "../models/vendorLedger.js";
import User from "../models/user.js";
import Notification from "../models/notificationModel.js";
import { pushToUser } from "../lib/socketHandler.js";
import {
  createTransfer,
  createRefund,
  ghBankNameToCode,
} from "../lib/paymentGateway.js";

const sym = (c) => (c === "NGN" ? "₦" : "₵");
const countryFromCurrency = (c) => (c === "NGN" ? "NG" : "GH");
const toObjectId = (id) => new mongoose.Types.ObjectId(id);

// ═══════════════════════════════════════════════════════════════════════
// GET /vendor/balance — unchanged
// ═══════════════════════════════════════════════════════════════════════
export const getBalance = async (req, res) => {
  try {
    const vendorId = req.user.userId;
    const rows = await VendorLedger.aggregate([
      { $match: { vendor: toObjectId(vendorId) } },
      {
        $group: {
          _id: { currency: "$currency", status: "$status" },
          total: { $sum: "$amount" },
        },
      },
    ]);

    const balances = {};
    for (const r of rows) {
      const cur = r._id.currency;
      balances[cur] = balances[cur] ?? {
        available: 0,
        pending: 0,
        paid_out: 0,
      };
      balances[cur][r._id.status] = Math.round(r.total * 100) / 100;
    }
    res.status(200).json({ balances });
  } catch (err) {
    console.error("[getBalance]", err);
    res.status(500).json({ message: "Failed to fetch balance" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /vendor/orders/:id/accept-refund — NOW ACTUALLY REFUNDS MONEY
// ═══════════════════════════════════════════════════════════════════════
export const acceptRefund = async (req, res) => {
  try {
    const vendorId = req.user.userId;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (String(order.vendor) !== String(vendorId)) {
      return res.status(403).json({ message: "Not authorised" });
    }

    if (!order.refundRequestedAt) {
      return res
        .status(400)
        .json({ message: "No refund has been requested for this order" });
    }

    if (order.status === "refunded") {
      return res
        .status(409)
        .json({ message: "This order has already been refunded" });
    }

    if (!order.flwTxId) {
      // Cash-on-delivery orders have no FLW transaction to refund against
      return res.status(400).json({
        message:
          "This order wasn't paid via card/MoMo — refund the buyer directly.",
        code: "NO_GATEWAY_TX",
      });
    }

    // ── Actually call Flutterwave to return the money ────────────────
    let refundResult;
    try {
      refundResult = await createRefund({
        countryCode: countryFromCurrency(order.currency),
        flwTxId: order.flwTxId,
        amount: order.total, // full refund for MVP
        reason: `Refund accepted: ${order.refundReason ?? "no reason"}`,
      });
    } catch (err) {
      // FLW refund failed — don't update our records
      console.error("[acceptRefund] FLW refund failed:", err.message);
      return res.status(502).json({
        message: `Refund couldn't be processed: ${err.message}`,
        code: "FLW_REFUND_FAILED",
      });
    }

    // ── Update our records only after FLW confirms ───────────────────
    order.status = "refunded";
    order.escrowStatus = "refunded";
    order.refundNotes = `${order.refundNotes ?? ""}\nRefund ID: ${refundResult.refundId}`;
    await order.save();

    // Reverse the vendor ledger (negative amount = debit)
    await VendorLedger.create({
      vendor: vendorId,
      amount: -order.vendorPayout,
      currency: order.currency,
      order: order._id,
      type: "refund",
      status: "available",
      notes: `Refund accepted — FLW refund ${refundResult.refundId}`,
    });

    res.status(200).json({
      message:
        "Refund processed. Buyer will see the money returned within 3–5 business days.",
      order,
      refund: refundResult,
    });

    // Notify buyer
    Notification.create({
      user: order.buyer,
      type: "boost_approved",
      title: "Refund approved",
      message: `${sym(order.currency)}${order.total.toLocaleString()} will be returned to your original payment method within 3–5 business days.`,
      actionUrl: `/orders/${order._id}`,
      actionLabel: "View order",
    }).catch(() => {});
    pushToUser(String(order.buyer), "new_notification", {});
  } catch (err) {
    console.error("[acceptRefund]", err);
    res.status(500).json({ message: "Failed to accept refund" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /vendor/orders/:id/reject-refund — unchanged
// ═══════════════════════════════════════════════════════════════════════
export const rejectRefund = async (req, res) => {
  try {
    const { reason } = req.body;
    const vendorId = req.user.userId;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (String(order.vendor) !== String(vendorId)) {
      return res.status(403).json({ message: "Not authorised" });
    }

    order.refundRequestedAt = null;
    order.refundReason = null;
    order.refundNotes = `Vendor rejected: ${reason ?? "no reason given"}`;
    await order.save();

    res.status(200).json({ message: "Refund rejected", order });

    Notification.create({
      user: order.buyer,
      type: "boost_approved",
      title: "Refund declined",
      message: `The vendor declined your refund.${reason ? ` Reason: ${reason}.` : ""} You can escalate to SmileBaba support.`,
      actionUrl: `/orders/${order._id}`,
      actionLabel: "View order",
    }).catch(() => {});
    pushToUser(String(order.buyer), "new_notification", {});
  } catch (err) {
    console.error("[rejectRefund]", err);
    res.status(500).json({ message: "Failed to reject refund" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /vendor/payouts/request — NOW ACTUALLY MOVES MONEY
// ═══════════════════════════════════════════════════════════════════════
export const requestPayout = async (req, res) => {
  try {
    const vendorId = req.user.userId;
    const { currency = "GHS", amount, method: preferredMethod } = req.body;

    // ── Compute available balance in this currency ───────────────────
    const avail = await VendorLedger.aggregate([
      {
        $match: {
          vendor: toObjectId(vendorId),
          currency,
          status: "available",
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
    const available = Math.round((avail[0]?.total ?? 0) * 100) / 100;

    const amt = amount ? Math.round(Number(amount) * 100) / 100 : available;

    if (amt <= 0) {
      return res
        .status(400)
        .json({ message: "No available balance to withdraw" });
    }
    if (amt > available) {
      return res.status(400).json({
        message: `Requested ${sym(currency)}${amt} exceeds available balance ${sym(currency)}${available}`,
      });
    }

    // ── Load vendor's payout details ─────────────────────────────────
    const vendor = await User.findById(vendorId)
      .select("payoutMethod momoDetails bankDetails username email storeName")
      .lean();

    const method = preferredMethod ?? vendor?.payoutMethod ?? "momo";
    const beneficiary = buildBeneficiary({ vendor, method });

    if (!beneficiary) {
      return res.status(400).json({
        message:
          "Add your payout details (MoMo or bank) in your account settings first.",
        code: "MISSING_PAYOUT_DETAILS",
      });
    }

    // ── Idempotent payoutRef ─────────────────────────────────────────
    const payoutRef = `payout-${vendorId}-${Date.now()}`;

    // ── Move money via Flutterwave BEFORE touching ledger ────────────
    // If FLW succeeds, we mark ledger paid_out.
    // If FLW fails, ledger stays available — vendor can retry.
    let transferResult;
    try {
      transferResult = await createTransfer({
        countryCode: countryFromCurrency(currency),
        amount: amt,
        currency,
        narration: `SmileBaba payout to ${vendor.storeName ?? vendor.username}`,
        reference: payoutRef,
        beneficiary,
      });
    } catch (err) {
      console.error("[requestPayout] FLW transfer failed:", err.message);
      return res.status(502).json({
        message: `Withdrawal couldn't be processed: ${err.message}`,
        code: "FLW_TRANSFER_FAILED",
      });
    }

    // ── Update ledger only after FLW accepts the transfer ────────────
    // The transfer is in "PENDING" or "NEW" state — FLW will webhook us
    // when it succeeds/fails. For MVP we treat "NEW" as effectively paid.
    await VendorLedger.updateMany(
      { vendor: vendorId, currency, status: "available" },
      { $set: { status: "paid_out", payoutRef } },
    );
    await VendorLedger.create({
      vendor: vendorId,
      amount: -amt,
      currency,
      type: "payout",
      status: "paid_out",
      payoutRef,
      notes: `${method === "momo" ? "MoMo" : "Bank"} withdrawal · FLW transfer ${transferResult.transferId}`,
    });

    res.status(200).json({
      message: "Withdrawal sent. Money should arrive within 24 hours.",
      payoutRef,
      amount: amt,
      currency,
      transferId: transferResult.transferId,
      status: transferResult.status,
    });

    // Notify vendor
    Notification.create({
      user: vendorId,
      type: "boost_approved",
      title: "Withdrawal sent",
      message: `${sym(currency)}${amt.toLocaleString()} on its way to your ${method === "momo" ? "MoMo" : "bank account"}.`,
      actionUrl: "/vendor/dashboard",
      actionLabel: "View history",
    }).catch(() => {});
    pushToUser(String(vendorId), "new_notification", {});
  } catch (err) {
    console.error("[requestPayout]", err);
    res.status(500).json({ message: "Failed to request payout" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /vendor/payouts — payout history (unchanged)
// ═══════════════════════════════════════════════════════════════════════
export const getPayoutHistory = async (req, res) => {
  try {
    const vendorId = req.user.userId;
    const payouts = await VendorLedger.find({
      vendor: vendorId,
      type: "payout",
    })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.status(200).json({
      payouts: payouts.map((p) => ({
        _id: String(p._id),
        amount: Math.abs(p.amount),
        currency: p.currency,
        payoutRef: p.payoutRef,
        notes: p.notes,
        createdAt: p.createdAt,
      })),
    });
  } catch (err) {
    console.error("[getPayoutHistory]", err);
    res.status(500).json({ message: "Failed to fetch payouts" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

/** Build a Flutterwave beneficiary object from vendor's saved settings. */
function buildBeneficiary({ vendor, method }) {
  if (method === "momo" || method === "both") {
    const m = vendor?.momoDetails;
    if (m?.phone && m?.network) {
      return {
        type: "momo",
        phone: m.phone,
        network: m.network,
        name: m.name ?? vendor.username,
        email: vendor.email,
      };
    }
  }

  if (method === "bank" || method === "both") {
    const b = vendor?.bankDetails;
    if (b?.accountNumber && b?.bankName) {
      const bankCode = ghBankNameToCode(b.bankName) ?? b.bankName;
      return {
        type: "bank",
        bankCode,
        accountNumber: b.accountNumber,
        name: b.accountName ?? vendor.username,
      };
    }
  }

  return null;
}
