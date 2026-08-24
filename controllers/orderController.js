// controllers/orderController.js
//
// Full order lifecycle:
//   getMyOrders          — buyer's orders (extended with more fields for mobile)
//   getVendorOrders      — vendor's received orders (kept as-is)
//   getSingleOrder       — populated single-order detail (mobile + web)
//   createOrder          — server-computes money math + policy snapshot
//   initOrderPayment     — POST /orders/:id/pay → Flutterwave link
//   verifyOrderPayment   — POST /orders/verify (mobile-callable)
//   orderPaymentWebhook  — Flutterwave webhook (independent source of truth)
//   confirmDelivery      — buyer releases escrow → vendor ledger credit
//   updateOrderStatus    — vendor marks confirmed/dispatched/delivered/cancelled
//   requestRefund        — buyer requests, vendor accepts/rejects from dashboard
//   reportDispute        — freezes vendor payout for that order, admin intervenes

import Order from "../models/orderModel.js";
import Ad from "../models/adModel.js";
import User from "../models/user.js";
import VendorLedger from "../models/vendorLedger.js";
import Notification from "../models/notificationModel.js";
import { sendSMS } from "../lib/smsService.js";
import {
  initializeGatewayPayment,
  verifyGatewayPayment,
  verifyWebhookSignature,
} from "../lib/paymentGateway.js";
import { pushToUser } from "../lib/socketHandler.js";

const COMMISSION_RATE = 0.05;

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

/** Round to 2dp. Every money computation goes through this. */
const money = (n) => Math.round(Number(n || 0) * 100) / 100;

/** Compute commission + vendor payout from subtotal. Server-only. */
function computeMoney(subtotal, rate = COMMISSION_RATE) {
  const s = money(subtotal);
  const commission = money(s * rate);
  const payout = money(s - commission);
  return { subtotal: s, commissionAmount: commission, vendorPayout: payout };
}

/** Category → payment model + escrow trigger + refund policy defaults. */
function policyForCategory(catMain, vendorHasSubaccount) {
  const cat = String(catMain || "marketplace").toLowerCase();

  // Split-at-source only works when vendor has a configured FLW subaccount
  const paymentModel =
    cat === "food" && vendorHasSubaccount ? "split_at_source" : "escrow";

  const escrowReleaseTrigger =
    cat === "food"
      ? "auto_on_delivery"
      : cat === "properties"
        ? "buyer_confirms"
        : cat === "services" || cat === "jobs"
          ? "buyer_confirms"
          : "buyer_confirms";

  const refundPolicy =
    cat === "food"
      ? { type: "vendor_cancel" }
      : cat === "properties"
        ? { type: "before_dispatch" }
        : cat === "services" || cat === "jobs"
          ? { type: "vendor_cancel" }
          : { type: "window", window: 7 };

  return { paymentModel, escrowReleaseTrigger, refundPolicy };
}

/** Given a policy snapshot + current status, is refund allowed right now? */
function isRefundEligible(policy, status) {
  if (!policy || policy.type === "none") return false;
  if (["cancelled", "refunded"].includes(status)) return false;

  switch (policy.type) {
    case "before_dispatch":
      return ["pending", "confirmed"].includes(status);
    case "vendor_cancel":
      return status === "cancelled";
    case "window":
      // Window is enforced against deliveredAt at request time
      return true;
    default:
      return true;
  }
}

/** Given order.currency, which Flutterwave country config to use. */
function countryFromCurrency(currency) {
  return currency === "NGN" ? "NG" : "GH";
}

/** Currency symbol for SMS/email display. */
const sym = (c) => (c === "NGN" ? "₦" : "₵");

// ═══════════════════════════════════════════════════════════════════════
// GET /orders/my (aliased at /orders/mine for mobile compatibility)
// ═══════════════════════════════════════════════════════════════════════
export const getMyOrders = async (req, res) => {
  try {
    const filter = { buyer: req.user.userId };

    // Optional status filter — "active" = paid/confirmed/dispatched
    const s = req.query.status;
    if (s === "active") {
      filter.status = { $in: ["confirmed", "dispatched", "pending"] };
    } else if (s && s !== "all") {
      filter.status = s;
    }

    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("vendor", "username storeName storePhone")
      .populate("ad", "title coverImage images")
      .lean();

    res.status(200).json({
      orders: orders.map((o) => ({
        _id: String(o._id),
        orderNumber: String(o._id).slice(-6).toUpperCase(),
        items: (o.items ?? []).map((it) => ({
          ...it,
          image: o.ad?.coverImage ?? o.ad?.images?.[0] ?? null,
          title: it.name,
          quantity: it.qty,
        })),
        subtotal: o.total ?? 0,
        total: o.total ?? 0,
        commissionAmount: o.commissionAmount ?? 0,
        vendorPayout: o.vendorPayout ?? 0,
        currency: o.currency ?? "GHS",
        symbol: sym(o.currency ?? "GHS"),
        status: o.status ?? "pending",
        paymentModel: o.paymentModel,
        escrowStatus: o.escrowStatus,
        refundEligible: isRefundEligible(o.refundPolicy, o.status ?? "pending"),
        refundPolicy: o.refundPolicy,
        vendor: o.vendor
          ? {
              _id: String(o.vendor._id),
              storeName: o.vendor.storeName ?? o.vendor.username,
              storePhone: o.vendor.storePhone,
            }
          : null,
        deliveryAddress: parseAddress(o.deliveryAddress),
        paidAt: o.paidAt ?? null,
        shippedAt: o.shippedAt ?? null,
        deliveredAt: o.deliveredAt ?? o.deliveryConfirmedAt ?? null,
        createdAt: o.createdAt,
        flwTxRef: o.flwTxRef,
      })),
    });
  } catch (err) {
    console.error("[getMyOrders]", err);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /orders/vendor (unchanged from your original)
// ═══════════════════════════════════════════════════════════════════════
export const getVendorOrders = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { vendor: req.user.userId };
    if (status && status !== "all") filter.status = status;

    const skip = (Number(page) - 1) * Number(limit);
    const [total, orders] = await Promise.all([
      Order.countDocuments(filter),
      Order.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .populate("buyer", "username phone")
        .populate("ad", "title")
        .lean(),
    ]);

    res.status(200).json({
      orders: orders.map((o) => ({
        _id: String(o._id),
        items: o.items ?? [],
        total: o.total ?? 0,
        commissionAmount: o.commissionAmount ?? 0,
        vendorPayout: o.vendorPayout ?? 0,
        currency: o.currency ?? "GHS",
        status: o.status ?? "pending",
        buyer: o.buyer?.username ?? "Customer",
        buyerPhone: o.buyer?.phone ?? "",
        adTitle: o.ad?.title ?? "",
        deliveryAddress: o.deliveryAddress ?? "",
        paymentModel: o.paymentModel,
        escrowStatus: o.escrowStatus,
        createdAt: o.createdAt,
      })),
      meta: { total, page: Number(page), limit: Number(limit) },
    });
  } catch (err) {
    console.error("[getVendorOrders]", err);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /orders/:id — single order detail (buyer or vendor or admin)
// ═══════════════════════════════════════════════════════════════════════
export const getSingleOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
      .populate("vendor", "username storeName storePhone storeSlug")
      .populate("buyer", "username phone email")
      .populate("ad", "title coverImage images category")
      .lean();

    if (!order) return res.status(404).json({ message: "Order not found" });

    const uid = String(req.user.userId);
    const isBuyer = String(order.buyer?._id ?? order.buyer) === uid;
    const isVendor = String(order.vendor?._id ?? order.vendor) === uid;
    const isAdmin = req.user.role === "admin";

    if (!isBuyer && !isVendor && !isAdmin) {
      return res.status(403).json({ message: "Not authorised" });
    }

    res.status(200).json({
      order: {
        _id: String(order._id),
        orderNumber: String(order._id).slice(-6).toUpperCase(),
        items: (order.items ?? []).map((it) => ({
          ...it,
          image: order.ad?.coverImage ?? order.ad?.images?.[0] ?? null,
          title: it.name,
          quantity: it.qty,
        })),
        subtotal: order.total ?? 0,
        total: order.total ?? 0,
        commissionAmount: order.commissionAmount ?? 0,
        vendorPayout: order.vendorPayout ?? 0,
        currency: order.currency ?? "GHS",
        symbol: sym(order.currency ?? "GHS"),
        status: order.status ?? "pending",
        paymentModel: order.paymentModel,
        escrowStatus: order.escrowStatus,
        refundEligible: isRefundEligible(
          order.refundPolicy,
          order.status ?? "pending",
        ),
        refundPolicy: order.refundPolicy,
        vendor: order.vendor
          ? {
              _id: String(order.vendor._id),
              storeName: order.vendor.storeName ?? order.vendor.username,
              storePhone: order.vendor.storePhone,
              storeSlug: order.vendor.storeSlug,
            }
          : null,
        buyer: isVendor || isAdmin ? order.buyer : undefined,
        deliveryAddress: parseAddress(order.deliveryAddress),
        paidAt: order.paidAt ?? null,
        shippedAt: order.shippedAt ?? null,
        deliveredAt: order.deliveredAt ?? order.deliveryConfirmedAt ?? null,
        deliveryConfirmedAt: order.deliveryConfirmedAt ?? null,
        deliveryConfirmedBy: order.deliveryConfirmedBy ?? null,
        escrowReleasedAt: order.escrowReleasedAt ?? null,
        refundRequestedAt: order.refundRequestedAt ?? null,
        refundReason: order.refundReason ?? null,
        flwTxRef: order.flwTxRef ?? null,
        createdAt: order.createdAt,
      },
    });
  } catch (err) {
    console.error("[getSingleOrder]", err);
    res.status(500).json({ message: "Failed to fetch order" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /orders — server owns all money math
// ═══════════════════════════════════════════════════════════════════════
export const createOrder = async (req, res) => {
  try {
    const buyerId = req.user.userId;
    const {
      adId: singleAdId, // legacy: single-ad orders (your existing shape)
      items: bodyItems, // new: array of { adId, quantity } OR { adId, qty }
      deliveryAddress,
      paymentMethod = "momo",
      notes,
      currency: requestedCurrency, // hint only — vendor's currency wins
    } = req.body;

    // ── Normalise inputs — support BOTH shapes ─────────────────────────
    // Legacy: { adId, items: [{name,qty,price}] } → keep as-is
    // Mobile: { items: [{ adId, quantity }] }    → derive from ads
    let orderLines;

    if (singleAdId && Array.isArray(bodyItems) && bodyItems[0]?.price != null) {
      // Legacy path — one ad, client-supplied items
      orderLines = [
        {
          adId: singleAdId,
          items: bodyItems.map((i) => ({
            qty: Math.max(1, parseInt(i.qty ?? i.quantity ?? 1, 10)),
          })),
        },
      ];
    } else if (Array.isArray(bodyItems) && bodyItems.length > 0) {
      // Mobile path — group by adId (in case multiple entries of same ad)
      const byAd = new Map();
      for (const it of bodyItems) {
        const adId = String(it.adId || "").trim();
        if (!adId) continue;
        const qty = Math.max(1, parseInt(it.qty ?? it.quantity ?? 1, 10));
        byAd.set(adId, (byAd.get(adId) ?? 0) + qty);
      }
      orderLines = [...byAd.entries()].map(([adId, qty]) => ({
        adId,
        items: [{ qty }],
      }));
    } else {
      return res.status(400).json({ message: "items array is required" });
    }

    if (orderLines.length === 0) {
      return res.status(400).json({ message: "No valid items in request" });
    }

    // ── Fetch all ads with vendors (single query) ──────────────────────
    const adIds = orderLines.map((l) => l.adId);
    const ads = await Ad.find({ _id: { $in: adIds } })
      .populate(
        "postedBy",
        "storeName storePhone phone username currency country flwSubaccountId email",
      )
      .lean();

    if (ads.length !== adIds.length) {
      return res.status(400).json({
        message: "One or more items are no longer available",
      });
    }

    // ── Enforce single-vendor per order (MVP) ──────────────────────────
    const vendorIds = [...new Set(ads.map((a) => String(a.postedBy?._id)))];
    if (vendorIds.length > 1) {
      return res.status(400).json({
        message:
          "This cart has items from multiple vendors. Please check them out one vendor at a time.",
        code: "MULTI_VENDOR_UNSUPPORTED",
        vendors: vendorIds,
      });
    }

    const vendor = ads[0].postedBy;
    if (!vendor?._id) {
      return res
        .status(400)
        .json({ message: "Vendor not found for this listing" });
    }

    // ── Prevent buyer from buying own listing ──────────────────────────
    if (String(vendor._id) === String(buyerId)) {
      return res
        .status(400)
        .json({ message: "You can't buy your own listing" });
    }

    // ── Currency: vendor's country decides ─────────────────────────────
    const currency =
      vendor.currency ?? (vendor.country === "Nigeria" ? "NGN" : "GHS");

    // ── Build items array from server-side data ────────────────────────
    const items = [];
    for (const line of orderLines) {
      const ad = ads.find((a) => String(a._id) === String(line.adId));
      const price = money(ad.price);
      if (price <= 0) {
        return res.status(400).json({
          message: `"${ad.title}" has no valid price. Contact the vendor.`,
        });
      }
      const totalQty = line.items.reduce((s, i) => s + i.qty, 0);
      items.push({
        name: ad.title,
        qty: totalQty,
        price,
      });
    }

    // ── Money math (server-only) ───────────────────────────────────────
    const subtotal = items.reduce((s, i) => s + i.price * i.qty, 0);
    const { commissionAmount, vendorPayout } = computeMoney(subtotal);
    const total = money(subtotal); // delivery fee added by vendor when known

    // ── Category-driven policy ─────────────────────────────────────────
    const catMain = ads[0].category?.main;
    const { paymentModel, escrowReleaseTrigger, refundPolicy } =
      policyForCategory(catMain, !!vendor.flwSubaccountId);

    // ── Persist ────────────────────────────────────────────────────────
    const order = await Order.create({
      buyer: buyerId,
      vendor: vendor._id,
      ad: ads[0]._id, // primary ad (single-vendor MVP)
      items,
      total,
      currency,
      status: paymentMethod === "cash" ? "confirmed" : "pending",
      deliveryAddress:
        typeof deliveryAddress === "object"
          ? JSON.stringify(deliveryAddress)
          : (deliveryAddress ?? ""),
      notes: notes ?? "",

      commissionRate: COMMISSION_RATE,
      commissionAmount,
      vendorPayout,

      escrowStatus: paymentMethod === "cash" ? "n/a" : "held",
      escrowReleaseTrigger,
      paymentModel: paymentMethod === "cash" ? "escrow" : paymentModel,
      refundPolicy,
      refundEligible: refundPolicy.type !== "none",
      flwSubaccountId: vendor.flwSubaccountId ?? null,
    });

    res.status(201).json({ message: "Order placed successfully", order });

    // ── Notifications (non-blocking) ───────────────────────────────────
    notifyVendorOfNewOrder({ order, ad: ads[0], vendor, currency }).catch((e) =>
      console.error("[notifyVendorOfNewOrder]", e.message),
    );
  } catch (err) {
    console.error("[createOrder]", err);
    res.status(500).json({
      message: err.message ?? "Failed to create order",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /orders/:id/pay — init Flutterwave for this order
// ═══════════════════════════════════════════════════════════════════════
export const initOrderPayment = async (req, res) => {
  try {
    const buyerId = req.user.userId;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (String(order.buyer) !== String(buyerId)) {
      return res.status(403).json({ message: "Not authorised" });
    }

    if (!["pending"].includes(order.status)) {
      return res.status(409).json({
        message: "This order can't be paid for right now.",
        currentStatus: order.status,
      });
    }

    const [buyer, vendor] = await Promise.all([
      User.findById(buyerId).select("email username phone whatsapp").lean(),
      User.findById(order.vendor).select("flwSubaccountId storeName").lean(),
    ]);

    // Fresh tx_ref every attempt so a failed payment can be retried without collision
    const tx_ref = `smilebaba-order-${order._id}-${Date.now()}`;
    order.flwTxRef = tx_ref;
    await order.save();

    // Resolve URLs (mirrors your subscription controller)
    const backendBase = (
      process.env.BACKEND_URL ??
      process.env.RENDER_EXTERNAL_URL ??
      `${req.protocol}://${req.get("host")}`
    ).replace(/\/+$/, "");
    const frontendBase = (
      process.env.NEXT_PUBLIC_APP_URL ??
      process.env.FRONTEND_URL ??
      "https://smilebabahub.com"
    ).replace(/\/+$/, "");

    // FLW redirects here after payment; static success page is fine because
    // mobile independently calls POST /orders/verify after browser closes.
    const redirect_url = `${frontendBase}/checkout/complete?order=${order._id}`;

    const payload = {
      tx_ref,
      amount: order.total,
      currency: order.currency,
      redirect_url,
      customer: {
        email: buyer?.email ?? "customer@smilebabahub.com",
        name: buyer?.username ?? "SmileBaba Customer",
        phonenumber: buyer?.phone ?? buyer?.whatsapp ?? "0000000000",
      },
      meta: {
        orderId: String(order._id),
        buyerId: String(buyerId),
        vendorId: String(order.vendor),
        purpose: "order", // distinguishes from subscription meta
        currency: order.currency,
      },
      customizations: {
        title: "SmileBaba Hub",
        description: `Order from ${vendor?.storeName ?? "SmileBaba vendor"}`,
        logo: `${frontendBase}/logo.png`,
        color: "#ffc105",
      },
    };

    // Split-at-source: add subaccount ONLY when vendor has one AND model is split
    if (order.paymentModel === "split_at_source" && vendor?.flwSubaccountId) {
      // Flutterwave splits by ratio; vendor gets (100 - commission) percent
      const vendorPercent = Math.round((1 - COMMISSION_RATE) * 100);
      payload.subaccounts = [
        {
          id: vendor.flwSubaccountId,
          transaction_split_ratio: vendorPercent,
        },
      ];
    }

    const countryCode = countryFromCurrency(order.currency);
    const { paymentLink } = await initializeGatewayPayment({
      countryCode,
      payload,
    });

    res.status(200).json({
      paymentLink,
      link: paymentLink, // alias — mobile code accepts either
      checkoutUrl: paymentLink,
      tx_ref,
      orderId: String(order._id),
    });
  } catch (err) {
    const msg =
      err.response?.data?.message ?? err.response?.data ?? err.message;
    console.error("[initOrderPayment]", msg);
    res.status(500).json({
      message: typeof msg === "string" ? msg : "Payment initialisation failed",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /orders/verify — mobile calls this after browser closes
// ═══════════════════════════════════════════════════════════════════════
export const verifyOrderPayment = async (req, res) => {
  try {
    const { orderId, transaction_id } = req.body;
    if (!orderId)
      return res.status(400).json({ message: "orderId is required" });

    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (String(order.buyer) !== String(req.user.userId)) {
      return res.status(403).json({ message: "Not authorised" });
    }

    // Already finalised — return current state
    if (
      ["confirmed", "dispatched", "delivered", "cancelled"].includes(
        order.status,
      )
    ) {
      return res.status(200).json({
        status: order.status === "pending" ? "pending" : "paid",
        order: sanitiseOrder(order),
      });
    }

    const countryCode = countryFromCurrency(order.currency);

    // If mobile passed transaction_id, use it; otherwise ask FLW by tx_ref
    let payment;
    try {
      payment = await verifyGatewayPayment({
        countryCode,
        transactionId: transaction_id ?? order.flwTxRef,
      });
    } catch (e) {
      // Verification failure → probably still pending
      console.warn("[verifyOrderPayment] gateway lookup failed:", e.message);
      return res.status(200).json({
        status: "pending",
        order: sanitiseOrder(order),
      });
    }

    if (payment?.status !== "successful") {
      return res.status(200).json({
        status: payment?.status === "pending" ? "pending" : "failed",
        order: sanitiseOrder(order),
      });
    }

    // Guard against amount tampering (allow overpayment for FLW fees; reject underpay >5%)
    const diff = Number(payment.amount) - order.total;
    if (diff < 0 && Math.abs(diff) / order.total > 0.05) {
      console.error("[verifyOrderPayment] underpayment", {
        paid: payment.amount,
        expected: order.total,
      });
      return res.status(400).json({
        message: "Payment amount doesn't match order total",
      });
    }

    // Finalise (idempotent — only writes on first successful verify)
    await markOrderPaid({ order, payment });

    // Reload fresh
    const updated = await Order.findById(orderId).lean();
    res.status(200).json({
      status: "paid",
      order: sanitiseOrder(updated),
    });
  } catch (err) {
    console.error("[verifyOrderPayment]", err);
    res.status(500).json({ message: "Verification failed" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /orders/webhook — Flutterwave server-to-server confirmation
// (Register raw-body parser in server.js for this path)
// ═══════════════════════════════════════════════════════════════════════
export const orderPaymentWebhook = async (req, res) => {
  try {
    // Signature check — figure out country from URL if pattern is
    // /orders/gh/webhook or /orders/ng/webhook; otherwise try both.
    // Simpler: FLW single-secret setup — verify with a "unknown" flag
    const countryCode = req.countryCode ?? "GH";

    const isValid = verifyWebhookSignature({
      countryCode,
      headers: req.headers,
      body: req.body,
    });
    if (!isValid) {
      console.warn("[orderPaymentWebhook] invalid signature");
      return res.status(401).end();
    }

    // Body may be Buffer (raw) or already parsed — handle both
    const payload = Buffer.isBuffer(req.body)
      ? JSON.parse(req.body.toString("utf8"))
      : req.body;

    const isCompleted =
      payload.event === "charge.completed" ||
      payload.event === "charge.success";
    const isSuccessful =
      payload.data?.status === "successful" ||
      payload.data?.status === "success";

    if (!isCompleted || !isSuccessful) return res.status(200).end();

    const data = payload.data;

    // Normalise meta (same shape logic as subscription webhook)
    const rawMeta = data.meta ?? data.payment_meta ?? data.metadata ?? {};
    const meta = Array.isArray(rawMeta)
      ? rawMeta.reduce((acc, i) => ({ ...acc, [i.metaname]: i.metavalue }), {})
      : rawMeta;

    // Only handle order payments (skip subscription webhook overlap)
    if (meta.purpose !== "order" || !meta.orderId) {
      return res.status(200).end();
    }

    const order = await Order.findById(meta.orderId);
    if (!order) {
      console.warn("[orderPaymentWebhook] order not found:", meta.orderId);
      return res.status(200).end();
    }

    // Idempotent: skip if already paid
    if (order.status !== "pending") {
      return res.status(200).end();
    }

    const amount = data.charged_amount ?? data.amount;

    // Same tolerance rules
    const diff = Number(amount) - order.total;
    if (diff < 0 && Math.abs(diff) / order.total > 0.05) {
      console.error("[orderPaymentWebhook] underpayment", {
        paid: amount,
        expected: order.total,
        orderId: order._id,
      });
      return res.status(200).end();
    }

    await markOrderPaid({
      order,
      payment: {
        id: data.id,
        amount,
        currency: data.currency,
        tx_ref: data.tx_ref ?? data.reference,
      },
    });

    res.status(200).end();
  } catch (err) {
    console.error("[orderPaymentWebhook]", err);
    res.status(200).end(); // always 200 to prevent FLW retry loops
  }
};

// ═══════════════════════════════════════════════════════════════════════
// PATCH /orders/:id/status — vendor updates
// ═══════════════════════════════════════════════════════════════════════
export const updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ["confirmed", "dispatched", "delivered", "cancelled"];
    if (!valid.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (
      String(order.vendor) !== String(req.user.userId) &&
      req.user.role !== "admin"
    ) {
      return res.status(403).json({ message: "Not authorised" });
    }

    order.status = status;
    if (status === "dispatched") order.shippedAt = new Date();
    if (status === "delivered") order.deliveredAt = new Date();

    // For food (auto_on_delivery), vendor marking delivered releases escrow
    if (
      status === "delivered" &&
      order.escrowReleaseTrigger === "auto_on_delivery"
    ) {
      await releaseEscrow({ order, actor: "vendor" });
    }

    await order.save();
    res.status(200).json({ message: "Order status updated", order });

    // SMS to buyer (unchanged)
    const [buyer, orderAd] = await Promise.all([
      User.findById(order.buyer).select("phone").lean(),
      Ad.findById(order.ad).select("category.main").lean(),
    ]);
    if (buyer?.phone) {
      const isDelivery = orderAd?.category?.main === "delivery";
      const msgs = {
        confirmed: isDelivery
          ? `SmileBaba: Your rider has confirmed! They will collect your item soon. 🛵`
          : `SmileBaba: Your order has been confirmed! The vendor will deliver soon.`,
        dispatched: `SmileBaba: Your order is on the way! 🛵 Track progress in the app.`,
        delivered: isDelivery
          ? `SmileBaba: Delivery complete! Your item has arrived. 📦`
          : `SmileBaba: Your order has been delivered. Enjoy! 🎉`,
        cancelled: `SmileBaba: Your order was cancelled. Contact support if this is unexpected.`,
      };
      sendSMS(buyer.phone, msgs[status]).catch((e) =>
        console.error("[SMS]", e.message),
      );
    }
  } catch (err) {
    console.error("[updateOrderStatus]", err);
    res.status(500).json({ message: "Failed to update order" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /orders/:id/confirm-delivery — buyer releases escrow
// ═══════════════════════════════════════════════════════════════════════
export const confirmDelivery = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (String(order.buyer) !== String(req.user.userId)) {
      return res.status(403).json({ message: "Not authorised" });
    }

    if (!["dispatched", "confirmed"].includes(order.status)) {
      return res.status(409).json({
        message: `Can't confirm delivery when status is "${order.status}"`,
      });
    }

    order.status = "delivered";
    order.deliveredAt = new Date();
    order.deliveryConfirmedAt = new Date();
    order.deliveryConfirmedBy = "buyer";

    if (order.escrowStatus === "held") {
      await releaseEscrow({ order, actor: "buyer" });
    }

    await order.save();

    res.status(200).json({
      message: "Delivery confirmed. Vendor has been paid.",
      order: sanitiseOrder(order),
    });

    // Notify vendor
    Notification.create({
      user: order.vendor,
      type: "boost_approved", // reuse existing enum; add "escrow_released" later
      title: "Payment released",
      message: `Buyer confirmed delivery. ${sym(order.currency)}${order.vendorPayout.toLocaleString()} added to your balance.`,
      actionUrl: "/vendor/dashboard",
      actionLabel: "View earnings",
    }).catch(() => {});

    pushToUser(String(order.vendor), "new_notification", {});
  } catch (err) {
    console.error("[confirmDelivery]", err);
    res.status(500).json({ message: "Failed to confirm delivery" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /orders/:id/refund — buyer requests refund
// ═══════════════════════════════════════════════════════════════════════
export const requestRefund = async (req, res) => {
  try {
    const { reason, notes } = req.body;
    if (!reason) return res.status(400).json({ message: "Reason is required" });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (String(order.buyer) !== String(req.user.userId)) {
      return res.status(403).json({ message: "Not authorised" });
    }

    if (!isRefundEligible(order.refundPolicy, order.status)) {
      return res.status(409).json({
        message:
          "This order isn't eligible for a refund under the vendor's policy.",
      });
    }

    // Extra check for window policy — enforce the day count
    if (order.refundPolicy?.type === "window" && order.deliveredAt) {
      const days = order.refundPolicy.window ?? 7;
      const cutoff = new Date(order.deliveredAt);
      cutoff.setDate(cutoff.getDate() + days);
      if (new Date() > cutoff) {
        return res.status(409).json({
          message: `The ${days}-day refund window has passed.`,
        });
      }
    }

    order.refundRequestedAt = new Date();
    order.refundReason = reason;
    order.refundNotes = notes ?? "";
    // We don't change status yet — vendor accepts/rejects from dashboard
    await order.save();

    res.status(200).json({
      message: "Refund request sent to vendor",
      order: sanitiseOrder(order),
    });

    // Notify vendor
    Notification.create({
      user: order.vendor,
      type: "boost_approved",
      title: "Refund requested",
      message: `A buyer has requested a refund. Reason: ${reason}. Review from your dashboard.`,
      actionUrl: "/vendor/orders",
      actionLabel: "Review refund",
    }).catch(() => {});
    pushToUser(String(order.vendor), "new_notification", {});
  } catch (err) {
    console.error("[requestRefund]", err);
    res.status(500).json({ message: "Failed to request refund" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /orders/:id/dispute — buyer escalates a problem
// ═══════════════════════════════════════════════════════════════════════
export const reportDispute = async (req, res) => {
  try {
    const { reason, notes } = req.body;
    if (!reason) return res.status(400).json({ message: "Reason is required" });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (String(order.buyer) !== String(req.user.userId)) {
      return res.status(403).json({ message: "Not authorised" });
    }

    // Freeze the order — admin resolves manually
    order.escrowStatus = "disputed";
    order.refundReason = reason;
    order.refundNotes = notes ?? "";
    order.refundRequestedAt = new Date();
    await order.save();

    res.status(200).json({
      message:
        "We've received your report. Support will reach out within 24 hours.",
      order: sanitiseOrder(order),
    });

    // Notify admins (send email to ADMIN_EMAILS, non-blocking)
    const adminEmails = (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .filter(Boolean);
    if (adminEmails.length) {
      // Reuse whatever email service you have; skipping detail here.
      console.log(
        `[dispute] Order ${order._id} disputed. Reason: ${reason}. Notify: ${adminEmails.join(", ")}`,
      );
    }
  } catch (err) {
    console.error("[reportDispute]", err);
    res.status(500).json({ message: "Failed to report problem" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════

async function markOrderPaid({ order, payment }) {
  // Idempotency guard — only set once
  if (order.status !== "pending") return;

  order.status = "confirmed";
  order.paidAt = new Date();
  order.flwTxId = String(payment.id ?? "");

  // For split_at_source, vendor was already paid at charge time —
  // record it as an "available" ledger row for our own bookkeeping.
  // For escrow, ledger stays pending until buyer confirms delivery.
  if (order.paymentModel === "split_at_source") {
    order.escrowStatus = "released";
    order.escrowReleasedAt = new Date();

    await VendorLedger.create({
      vendor: order.vendor,
      amount: order.vendorPayout,
      currency: order.currency,
      order: order._id,
      type: "sale",
      status: "paid_out", // FLW already sent it
      notes: "Split-at-source direct payout",
    });
  } else {
    await VendorLedger.create({
      vendor: order.vendor,
      amount: order.vendorPayout,
      currency: order.currency,
      order: order._id,
      type: "sale",
      status: "pending", // becomes "available" on confirmDelivery
      notes: "Escrow — pending buyer confirmation",
    });
  }

  await order.save();

  // Notify buyer + vendor
  Promise.all([
    Notification.create({
      user: order.buyer,
      type: "boost_approved",
      title: "Payment received",
      message: `Your order is confirmed and the vendor has been notified.`,
      actionUrl: `/orders/${order._id}`,
      actionLabel: "View order",
    }),
    Notification.create({
      user: order.vendor,
      type: "boost_approved",
      title: "New paid order",
      message: `${sym(order.currency)}${order.total.toLocaleString()} paid. Start preparing.`,
      actionUrl: "/vendor/orders",
      actionLabel: "View orders",
    }),
  ]).catch(() => {});

  pushToUser(String(order.buyer), "new_notification", {});
  pushToUser(String(order.vendor), "new_notification", {});
}

async function releaseEscrow({ order, actor }) {
  if (order.escrowStatus !== "held") return;

  order.escrowStatus = "released";
  order.escrowReleasedAt = new Date();
  if (!order.deliveryConfirmedAt) {
    order.deliveryConfirmedAt = new Date();
    order.deliveryConfirmedBy = actor;
  }

  // Flip the pending ledger row to available
  await VendorLedger.updateMany(
    { order: order._id, type: "sale", status: "pending" },
    {
      $set: {
        status: "available",
        notes: `Released to vendor on ${actor} confirmation`,
      },
    },
  );
}

async function notifyVendorOfNewOrder({ order, ad, vendor, currency }) {
  const vendorFull = await User.findById(vendor._id)
    .select("phone email username")
    .lean();
  if (vendorFull?.phone) {
    const isDelivery = ad.category?.main === "delivery";
    const smsBody = isDelivery
      ? `SmileBaba: New delivery booking! ${sym(currency)}${order.total.toLocaleString()}. ` +
        `Route: ${String(order.deliveryAddress || "").slice(0, 80)}. ` +
        `Confirm: https://smilebabahub.com/vendor/orders`
      : `SmileBaba: New order for "${ad.title}" — ${sym(currency)}${order.total.toLocaleString()}. ` +
        `Log in to confirm: https://smilebabahub.com/vendor/orders`;
    sendSMS(vendorFull.phone, smsBody).catch(() => {});
  }

  Notification.create({
    user: vendor._id,
    type: "boost_approved",
    title: "New order",
    message: `${sym(currency)}${order.total.toLocaleString()} — awaiting payment confirmation.`,
    actionUrl: "/vendor/orders",
    actionLabel: "View order",
  }).catch(() => {});

  pushToUser(String(vendor._id), "new_notification", {});
}

function parseAddress(a) {
  if (!a) return null;
  if (typeof a === "object") return a;
  try {
    return JSON.parse(a);
  } catch {
    return { address: String(a) };
  }
}

function sanitiseOrder(o) {
  const raw = o.toObject ? o.toObject() : o;
  return {
    _id: String(raw._id),
    orderNumber: String(raw._id).slice(-6).toUpperCase(),
    items: raw.items ?? [],
    subtotal: raw.total ?? 0,
    total: raw.total ?? 0,
    currency: raw.currency ?? "GHS",
    symbol: sym(raw.currency ?? "GHS"),
    status: raw.status ?? "pending",
    paymentModel: raw.paymentModel,
    escrowStatus: raw.escrowStatus,
    refundEligible: isRefundEligible(raw.refundPolicy, raw.status ?? "pending"),
    refundPolicy: raw.refundPolicy,
    deliveryAddress: parseAddress(raw.deliveryAddress),
    paidAt: raw.paidAt,
    shippedAt: raw.shippedAt,
    deliveredAt: raw.deliveredAt ?? raw.deliveryConfirmedAt,
    flwTxRef: raw.flwTxRef,
    createdAt: raw.createdAt,
  };
}
