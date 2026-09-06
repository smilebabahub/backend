// cron/autoPayout.js
//
// Runs on a schedule and triggers payouts for vendors who have
// payoutSchedule set to daily / weekly / monthly.
//
// Register in server.js:
//   import { startAutoPayoutCron } from "./cron/autoPayout.js";
//   startAutoPayoutCron();

import cron from "node-cron";
import mongoose from "mongoose";
import User from "../models/user.js";
import VendorLedger from "../models/vendorLedger.js";
import Notification from "../models/notificationModel.js";
import { createTransfer, ghBankNameToCode } from "../lib/paymentGateway.js";
import { pushToUser } from "../lib/socketHandler.js";

const sym = (c) => (c === "NGN" ? "₦" : "₵");
const countryFromCurrency = (c) => (c === "NGN" ? "NG" : "GH");

const MIN_PAYOUT = { GHS: 50, NGN: 5000 }; // don't pay out tiny amounts

// ─── Main entry ─────────────────────────────────────────────────────
export function startAutoPayoutCron() {
  // Every day at 2am server time — reasonable low-traffic window
  cron.schedule("0 2 * * *", async () => {
    console.log("[autoPayout] daily run starting");
    await runPayouts("daily");

    // Sunday runs also process weekly
    if (new Date().getDay() === 0) {
      console.log("[autoPayout] Sunday — running weekly");
      await runPayouts("weekly");
    }

    // 1st of month also runs monthly
    if (new Date().getDate() === 1) {
      console.log("[autoPayout] 1st of month — running monthly");
      await runPayouts("monthly");
    }

    console.log("[autoPayout] run complete");
  });
  // cron.schedule("0 2 * * *", runPayouts, { timezone: "Africa/Accra" });
  console.log("[autoPayout] scheduler registered (runs daily at 2am)");
}

// ─── Process all eligible vendors for a given schedule ──────────────
async function runPayouts(schedule) {
  const vendors = await User.find({
    payoutSchedule: schedule,
    role: { $in: ["vendor", "admin"] },
  })
    .select(
      "_id username storeName email payoutMethod momoDetails bankDetails country currency",
    )
    .lean();

  console.log(`[autoPayout] ${vendors.length} vendors on ${schedule} schedule`);

  for (const vendor of vendors) {
    try {
      await payoutOneVendor(vendor);
    } catch (err) {
      // Log and continue — one vendor failing shouldn't stop the batch
      console.error(`[autoPayout] vendor ${vendor._id} failed:`, err.message);
    }
  }
}

// ─── Pay out all available balance for one vendor ───────────────────
async function payoutOneVendor(vendor) {
  // Check all currencies vendor might have a balance in
  const currencies = await VendorLedger.distinct("currency", {
    vendor: vendor._id,
    status: "available",
  });

  for (const currency of currencies) {
    const avail = await VendorLedger.aggregate([
      {
        $match: {
          vendor: new mongoose.Types.ObjectId(vendor._id),
          currency,
          status: "available",
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);

    const amt = Math.round((avail[0]?.total ?? 0) * 100) / 100;
    if (amt < (MIN_PAYOUT[currency] ?? 50)) {
      console.log(
        `[autoPayout] vendor ${vendor._id} ${currency}: balance ${amt} below minimum ${MIN_PAYOUT[currency]}, skipping`,
      );
      continue;
    }

    const beneficiary = buildBeneficiary({
      vendor,
      method: vendor.payoutMethod ?? "momo",
    });
    if (!beneficiary) {
      console.log(
        `[autoPayout] vendor ${vendor._id} has no payout method configured, skipping`,
      );
      continue;
    }

    const payoutRef = `auto-${vendor._id}-${Date.now()}`;

    let transferResult;
    try {
      transferResult = await createTransfer({
        countryCode: countryFromCurrency(currency),
        amount: amt,
        currency,
        narration: `SmileBaba auto payout for ${vendor.storeName ?? vendor.username}`,
        reference: payoutRef,
        beneficiary,
      });
    } catch (err) {
      console.error(
        `[autoPayout] transfer failed for ${vendor._id}: ${err.message}`,
      );
      // Notify vendor of failure
      Notification.create({
        user: vendor._id,
        type: "boost_approved",
        title: "Auto-payout failed",
        message: `Your scheduled withdrawal of ${sym(currency)}${amt.toLocaleString()} couldn't be sent. Please check your payout settings.`,
        actionUrl: "/vendor/settings/payments",
        actionLabel: "Fix settings",
      }).catch(() => {});
      continue;
    }

    // Update ledger — FLW confirmed the transfer
    await VendorLedger.updateMany(
      { vendor: vendor._id, currency, status: "available" },
      { $set: { status: "paid_out", payoutRef } },
    );
    await VendorLedger.create({
      vendor: vendor._id,
      amount: -amt,
      currency,
      type: "payout",
      status: "paid_out",
      payoutRef,
      notes: `Auto ${vendor.payoutSchedule} payout · FLW transfer ${transferResult.transferId}`,
    });

    console.log(
      `[autoPayout] paid ${sym(currency)}${amt} to vendor ${vendor._id} — ${transferResult.transferId}`,
    );

    // Notify vendor
    Notification.create({
      user: vendor._id,
      type: "boost_approved",
      title: "Auto-payout sent",
      message: `${sym(currency)}${amt.toLocaleString()} on its way to your account.`,
      actionUrl: "/vendor/dashboard",
      actionLabel: "View history",
    }).catch(() => {});
    pushToUser(String(vendor._id), "new_notification", {});
  }
}

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
