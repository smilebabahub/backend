// ═══════════════════════════════════════════════════════════════════════
// controllers/transferController.js
// ═══════════════════════════════════════════════════════════════════════

import Transfer     from "../models/transferModel.js";
import Notification from "../models/notificationModel.js";
import { pushToUser } from "../lib/socketHandler.js";

const sym = (c) =>
  c === "NGN" ? "₦" : c === "GHS" ? "₵" : c === "SLE" ? "Le" :
  c === "GBP" ? "£" : c === "EUR" ? "€" : "$";

const fmt = (amount, currency) => {
  const n = Number(amount);
  if (!isFinite(n)) return "—";
  return `${sym(currency)}${n.toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;
};

// Never store a full recipient number
const maskPhone = (p) => {
  const s = String(p ?? "").replace(/\D/g, "");
  return s.length > 4 ? `••••${s.slice(-4)}` : undefined;
};

// ─── POST /transfers/record ──────────────────────────────────────────
// Called by the hosted page AND the mobile app after Clozar's onSuccess.
// Both may fire — upsert on payoutRef makes the second call a no-op.
export const recordTransfer = async (req, res) => {
  try {
    const {
      payoutRef, sendAmount, receiveAmount,
      sendCurrency, receiveCurrency, rate, fee,
      recipientName, recipientPhone, raw,
    } = req.body;

    if (!payoutRef) {
      return res.status(400).json({ message: "payoutRef is required" });
    }

    const transfer = await Transfer.findOneAndUpdate(
      { payoutRef },
      {
        $setOnInsert: {
          user:            req.user.userId,
          provider:        "clozar",
          payoutRef,
          sendAmount:      Number(sendAmount) || undefined,
          receiveAmount:   Number(receiveAmount) || undefined,
          sendCurrency,
          receiveCurrency,
          rate:            Number(rate) || undefined,
          fee:             Number(fee) || undefined,
          recipientName,
          recipientPhone:  maskPhone(recipientPhone),
          status:          "completed",
          raw,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.status(200).json({ transfer: serialise(transfer) });

    // Only notify on first insert — compare timestamps to detect it
    const isNew =
      Math.abs(new Date(transfer.createdAt) - new Date(transfer.updatedAt)) < 1000;
    if (isNew) {
      Notification.create({
        user:        req.user.userId,
        type:        "boost_approved",   // swap when a money type exists
        title:       "Transfer sent",
        message:     `${fmt(transfer.receiveAmount, transfer.receiveCurrency)} sent to ${transfer.recipientName ?? "your recipient"}.`,
        actionUrl:   `/money/${transfer._id}`,
        actionLabel: "View receipt",
        dedupeKey:   `transfer-${payoutRef}`,
      }).catch(() => {});
      pushToUser(String(req.user.userId), "new_notification", {});
    }
  } catch (err) {
    console.error("[recordTransfer]", err);
    res.status(500).json({ message: "Couldn't save that transfer." });
  }
};

// ─── GET /transfers ──────────────────────────────────────────────────
export const getMyTransfers = async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const transfers = await Transfer.find({ user: req.user.userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.status(200).json({ transfers: transfers.map(serialise) });
  } catch (err) {
    console.error("[getMyTransfers]", err);
    res.status(500).json({ message: "Couldn't load your transfers." });
  }
};

// ─── GET /transfers/:id ──────────────────────────────────────────────
export const getTransfer = async (req, res) => {
  try {
    const transfer = await Transfer.findById(req.params.id).lean();
    if (!transfer) return res.status(404).json({ message: "Transfer not found" });

    if (String(transfer.user) !== String(req.user.userId) && req.user.role !== "admin") {
      return res.status(403).json({ message: "Not authorised" });
    }
    res.status(200).json({ transfer: serialise(transfer) });
  } catch (err) {
    console.error("[getTransfer]", err);
    res.status(500).json({ message: "Couldn't load that transfer." });
  }
};

function serialise(t) {
  const raw = t.toObject ? t.toObject() : t;
  return {
    _id:       String(raw._id),
    reference: raw.payoutRef,
    status:    raw.status,
    provider:  raw.provider,

    sendAmount:      raw.sendAmount,
    sendCurrency:    raw.sendCurrency,
    receiveAmount:   raw.receiveAmount,
    receiveCurrency: raw.receiveCurrency,
    rate:            raw.rate,
    fee:             raw.fee,

    display: {
      sendAmount:    fmt(raw.sendAmount, raw.sendCurrency),
      receiveAmount: fmt(raw.receiveAmount, raw.receiveCurrency),
      fee:           raw.fee != null ? fmt(raw.fee, raw.sendCurrency) : undefined,
      rate: raw.rate
        ? `1 ${raw.sendCurrency} = ${Number(raw.rate).toLocaleString(undefined, {
            minimumFractionDigits: 4, maximumFractionDigits: 4,
          })} ${raw.receiveCurrency}`
        : undefined,
    },

    recipient: {
      name:  raw.recipientName,
      phone: raw.recipientPhone,
    },

    createdAt: raw.createdAt,
  };
}

