// controllers/orderController.js
//
// Full order lifecycle.
//
//   getMyOrders          — buyer's orders
//   getVendorOrders      — vendor's received orders (their items only)
//   getSingleOrder       — one populated order, with journey
//   getOrderGroup        — every order in a multi-vendor checkout
//   createOrder          — splits a cart into one order per vendor
//   initOrderPayment     — one Flutterwave charge for a whole group
//   verifyOrderPayment   — app calls this when the browser closes
//   orderPaymentWebhook  — Flutterwave's confirmation (source of truth)
//   updateOrderStatus    — vendor marks confirmed/dispatched/delivered/cancelled
//   confirmDelivery      — buyer releases escrow → vendor ledger credit
//   requestRefund        — buyer requests, vendor resolves from dashboard
//   reportDispute        — freezes payout, admin intervenes
//
// MULTI-VENDOR
//   A cart spanning three vendors becomes three Order documents sharing one
//   `orderGroup`. Each vendor sees and fulfils only their own items. The
//   buyer pays once, and escrow releases per vendor.
//
// TIMELINE
//   Every status change appends to order.timeline. Append-only, so a
//   cancelled order still shows it was confirmed and dispatched first.
//
// Requires on models/orderModel.js:
//   orderGroup:  { type: String, index: true },
//   deliveryFee: { type: Number, default: 0 },
//   timeline: [{
//     status: { type: String, required: true },
//     label:  String,
//     note:   String,
//     actor:  { type: String, enum: ["buyer", "vendor", "system", "admin"] },
//     at:     { type: Date, default: Date.now },
//   }],

import crypto from "crypto";

import Order from "../models/orderModel.js";
import Ad from "../models/adModel.js";
import User from "../models/user.js";
import VendorLedger from "../models/vendorLedger.js";
import { sendSMS } from "../lib/smsService.js";
import {
  initializeGatewayPayment,
  verifyGatewayPayment,
  verifyWebhookSignature,
} from "../lib/paymentGateway.js";
import { notify } from "../lib/notify.js";
import {
  addTimelineEntry,
  buildJourney,
  statusSummary,
} from "../lib/orderTimeline.js";

const COMMISSION_RATE = 0.05;

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════

/** Round to 2dp. Every money computation goes through this. */
const money = (n) => Math.round(Number(n || 0) * 100) / 100;

/** Compute commission + vendor payout from a subtotal. Server-only. */
function computeMoney(subtotal, rate = COMMISSION_RATE) {
  const s = money(subtotal);
  const commission = money(s * rate);
  const payout = money(s - commission);
  return { subtotal: s, commissionAmount: commission, vendorPayout: payout };
}

/** Read a price off an ad. Handles { amount, currency } and legacy flat. */
function adPrice(ad) {
  const p = ad?.price;
  if (p && typeof p === "object") return money(p.amount);
  return money(p);
}

/** Read a currency off an ad, falling back to its country. */
function adCurrency(ad) {
  const p = ad?.price;
  if (p && typeof p === "object" && p.currency) {
    return String(p.currency).toUpperCase();
  }
  return ad?.location?.country === "Nigeria" ||
    ad?.location?.countryCode === "NG"
    ? "NGN"
    : "GHS";
}

/** Category → payment model + escrow trigger + refund policy defaults. */
function policyForCategory(catMain, vendorHasSubaccount) {
  const cat = String(catMain || "marketplace").toLowerCase();

  // Split-at-source only works when the vendor has a configured FLW subaccount
  const paymentModel =
    cat === "food" && vendorHasSubaccount ? "split_at_source" : "escrow";

  const escrowReleaseTrigger =
    cat === "food" ? "auto_on_delivery" : "buyer_confirms";

  // "apartments" is the live category name; "properties" kept for old rows
  const refundPolicy =
    cat === "food"
      ? { type: "vendor_cancel" }
      : cat === "apartments" || cat === "properties"
        ? { type: "before_dispatch" }
        : cat === "services" || cat === "jobs"
          ? { type: "vendor_cancel" }
          : { type: "window", window: 7 };

  return { paymentModel, escrowReleaseTrigger, refundPolicy };
}

/** Given a policy snapshot + current status, is a refund allowed right now? */
function isRefundEligible(policy, status) {
  if (!policy || policy.type === "none") return false;
  if (["cancelled", "refunded"].includes(status)) return false;

  switch (policy.type) {
    case "before_dispatch":
      return ["pending", "confirmed"].includes(status);
    case "vendor_cancel":
      return status === "cancelled";
    case "window":
      // Day count is enforced against deliveredAt at request time
      return true;
    default:
      return true;
  }
}

/** Which Flutterwave country config a currency maps to. */
function countryFromCurrency(currency) {
  return currency === "NGN" ? "NG" : "GH";
}

/** Currency symbol for SMS and notification copy. */
const sym = (c) => (c === "NGN" ? "₦" : "₵");

// ═══════════════════════════════════════════════════════════════════════
// GET /orders/my   (aliased at /orders/mine)
// ═══════════════════════════════════════════════════════════════════════
export const getMyOrders = async (req, res) => {
  try {
    const filter = { buyer: req.user.userId };

    const s = req.query.status;
    if (s === "active") {
      filter.status = { $in: ["pending", "confirmed", "dispatched"] };
    } else if (s && s !== "all") {
      filter.status = s;
    }

    const limit = Math.min(100, parseInt(req.query.limit, 10) || 50);

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate("vendor", "username storeName storePhone storeSlug")
      .populate("ad", "title coverImage images")
      .lean();

    res.status(200).json({
      orders: orders.map((o) => ({
        _id: String(o._id),
        orderNumber: String(o._id).slice(-6).toUpperCase(),
        orderGroup: o.orderGroup ?? null,
        items: (o.items ?? []).map((it) => ({
          ...it,
          image: o.ad?.coverImage ?? o.ad?.images?.[0]?.url ?? null,
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
        statusLabel: statusSummary(o),
        paymentModel: o.paymentModel,
        escrowStatus: o.escrowStatus,
        refundEligible: isRefundEligible(o.refundPolicy, o.status ?? "pending"),
        refundPolicy: o.refundPolicy,
        vendor: o.vendor
          ? {
              _id: String(o.vendor._id),
              storeName: o.vendor.storeName ?? o.vendor.username,
              storePhone: o.vendor.storePhone,
              storeSlug: o.vendor.storeSlug,
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
// GET /orders/vendor — a vendor only ever sees their own orders
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
        .populate("ad", "title coverImage images")
        .lean(),
    ]);

    res.status(200).json({
      orders: orders.map((o) => ({
        _id: String(o._id),
        orderNumber: String(o._id).slice(-6).toUpperCase(),
        items: (o.items ?? []).map((it) => ({
          ...it,
          title: it.name,
          quantity: it.qty,
        })),
        total: o.total ?? 0,
        commissionAmount: o.commissionAmount ?? 0,
        vendorPayout: o.vendorPayout ?? 0,
        currency: o.currency ?? "GHS",
        symbol: sym(o.currency ?? "GHS"),
        status: o.status ?? "pending",
        statusLabel: statusSummary(o),
        buyer: o.buyer?.username ?? "Customer",
        // Buyer's phone unlocks only once they've paid — an unpaid order
        // is not a free lead.
        buyerPhone: o.status === "pending" ? "" : (o.buyer?.phone ?? ""),
        adTitle: o.ad?.title ?? "",
        image: o.ad?.coverImage ?? o.ad?.images?.[0]?.url ?? null,
        deliveryAddress: parseAddress(o.deliveryAddress),
        paymentModel: o.paymentModel,
        escrowStatus: o.escrowStatus,
        refundRequestedAt: o.refundRequestedAt ?? null,
        refundReason: o.refundReason ?? null,
        timeline: o.timeline ?? [],
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
// GET /orders/group/:groupId — every order from one checkout
// ═══════════════════════════════════════════════════════════════════════
export const getOrderGroup = async (req, res) => {
  try {
    const orders = await Order.find({
      orderGroup: req.params.groupId,
      buyer: req.user.userId,
    })
      .populate("vendor", "username storeName storePhone storeSlug")
      .populate("ad", "title coverImage images")
      .lean();

    if (orders.length === 0) {
      return res.status(404).json({ message: "Order not found" });
    }

    const total = money(orders.reduce((s, o) => s + (o.total ?? 0), 0));

    res.status(200).json({
      orderGroup: req.params.groupId,
      orders: orders.map((o) => ({
        ...sanitiseOrder(o),
        vendor: o.vendor
          ? {
              _id: String(o.vendor._id),
              storeName: o.vendor.storeName ?? o.vendor.username,
              storeSlug: o.vendor.storeSlug,
            }
          : null,
        image: o.ad?.coverImage ?? o.ad?.images?.[0]?.url ?? null,
      })),
      summary: {
        subtotal: total,
        total,
        currency: orders[0].currency ?? "GHS",
        symbol: sym(orders[0].currency ?? "GHS"),
        vendorCount: orders.length,
        allPaid: orders.every((o) => o.status !== "pending"),
      },
    });
  } catch (err) {
    console.error("[getOrderGroup]", err);
    res.status(500).json({ message: "Failed to fetch order" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /orders/:id — buyer, vendor, or admin
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
        orderGroup: order.orderGroup ?? null,
        items: (order.items ?? []).map((it) => ({
          ...it,
          image: order.ad?.coverImage ?? order.ad?.images?.[0]?.url ?? null,
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
        statusLabel: statusSummary(order),
        timeline: order.timeline ?? [],
        journey: buildJourney(order),
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
// POST /orders
//
// Body: { items: [{ adId, quantity }], deliveryAddress, paymentMethod, notes }
// Legacy single-ad body { adId } still works.
//
// The client sends ids and quantities only. Every price, subtotal,
// commission and payout is computed here from the Ad documents.
// ═══════════════════════════════════════════════════════════════════════
export const createOrder = async (req, res) => {
  try {
    const buyerId = req.user.userId;
    const {
      adId: legacyAdId,
      items: bodyItems,
      deliveryAddress,
      paymentMethod = "momo",
      notes,
    } = req.body;

    // ── Collapse the request into adId → quantity ────────────────────
    const wanted = new Map();

    if (Array.isArray(bodyItems) && bodyItems.length > 0) {
      for (const it of bodyItems) {
        const id = String(it.adId ?? it.id ?? "").trim();
        if (!id) continue;
        const qty = Math.max(1, parseInt(it.quantity ?? it.qty ?? 1, 10) || 1);
        wanted.set(id, (wanted.get(id) ?? 0) + qty);
      }
    } else if (legacyAdId) {
      const qty = Math.max(
        1,
        parseInt(bodyItems?.[0]?.qty ?? bodyItems?.[0]?.quantity ?? 1, 10) || 1,
      );
      wanted.set(String(legacyAdId), qty);
    }

    if (wanted.size === 0) {
      return res.status(400).json({ message: "Your cart is empty." });
    }

    // ── Load every ad with its vendor, one query ─────────────────────
    const adIds = [...wanted.keys()];
    const ads = await Ad.find({ _id: { $in: adIds } })
      .populate(
        "postedBy",
        "username storeName storePhone phone whatsapp email flwSubaccountId",
      )
      .lean();

    if (ads.length !== adIds.length) {
      const found = new Set(ads.map((a) => String(a._id)));
      return res.status(400).json({
        message: "Some items are no longer available. Please review your cart.",
        code: "ITEMS_UNAVAILABLE",
        unavailable: adIds.filter((id) => !found.has(id)),
      });
    }

    // ── Reject anything not actually buyable ─────────────────────────
    const gone = ads.filter(
      (a) => a.isSold || a.isPaused || a.isActive === false,
    );
    if (gone.length > 0) {
      return res.status(400).json({
        message: `"${gone[0].title}" is no longer available.`,
        code: "ITEMS_UNAVAILABLE",
        unavailable: gone.map((a) => String(a._id)),
      });
    }

    // ── One currency per checkout ────────────────────────────────────
    const currencies = new Set(ads.map(adCurrency));
    if (currencies.size > 1) {
      return res.status(400).json({
        message:
          "Your cart mixes currencies. Please check out one country's items at a time.",
        code: "MIXED_CURRENCY",
      });
    }
    const currency = [...currencies][0] ?? "GHS";

    // ── Group the cart by vendor ─────────────────────────────────────
    const byVendor = new Map(); // vendorId → { vendor, lines[] }

    for (const ad of ads) {
      const vendor = ad.postedBy;
      if (!vendor?._id) {
        return res.status(400).json({
          message: `"${ad.title}" has no vendor attached. Please contact support.`,
        });
      }

      const vendorId = String(vendor._id);
      if (vendorId === String(buyerId)) {
        return res.status(400).json({
          message: "You can't buy your own listing.",
          code: "OWN_LISTING",
        });
      }

      const price = adPrice(ad);
      if (!(price > 0)) {
        return res.status(400).json({
          message: `"${ad.title}" doesn't have a price set. Message the vendor instead.`,
          code: "NO_PRICE",
        });
      }

      if (!byVendor.has(vendorId))
        byVendor.set(vendorId, { vendor, lines: [] });
      byVendor.get(vendorId).lines.push({
        ad,
        qty: wanted.get(String(ad._id)),
        price,
      });
    }

    // ── Build one order document per vendor ──────────────────────────
    const orderGroup = crypto.randomUUID();
    const isCash = paymentMethod === "cash";
    const addressStr =
      typeof deliveryAddress === "object"
        ? JSON.stringify(deliveryAddress)
        : (deliveryAddress ?? "");
    const multiVendor = byVendor.size > 1;

    const docs = [];

    for (const [, { vendor, lines }] of byVendor) {
      const items = lines.map((l) => ({
        ad: l.ad._id,
        name: l.ad.title,
        qty: l.qty,
        price: l.price,
      }));

      const rawSubtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
      const { subtotal, commissionAmount, vendorPayout } =
        computeMoney(rawSubtotal);

      const catMain = lines[0].ad.category?.main;
      const { paymentModel, escrowReleaseTrigger, refundPolicy } =
        policyForCategory(catMain, !!vendor.flwSubaccountId);

      docs.push({
        buyer: buyerId,
        vendor: vendor._id,
        ad: lines[0].ad._id, // primary ad, used for thumbnails
        orderGroup,
        items,
        total: subtotal, // delivery fee added by the vendor when known
        currency,
        status: isCash ? "confirmed" : "pending",
        deliveryAddress: addressStr,
        notes: notes ?? "",

        commissionRate: COMMISSION_RATE,
        commissionAmount,
        vendorPayout,

        escrowStatus: isCash ? "n/a" : "held",
        escrowReleaseTrigger,
        // Flutterwave can only split to one subaccount per charge, so a
        // multi-vendor group always falls back to escrow.
        paymentModel: isCash || multiVendor ? "escrow" : paymentModel,
        refundPolicy,
        refundEligible: refundPolicy.type !== "none",
        flwSubaccountId: vendor.flwSubaccountId ?? null,

        timeline: [
          {
            status: "placed",
            label: "Order placed",
            note: isCash
              ? "Pay the vendor on delivery."
              : "Waiting for payment to be confirmed.",
            actor: "buyer",
            at: new Date(),
          },
        ],
      });
    }

    const orders = await Order.insertMany(docs);
    const grandTotal = money(orders.reduce((s, o) => s + o.total, 0));

    res.status(201).json({
      message: "Order placed successfully",
      orderGroup,
      orders: orders.map(sanitiseOrder),
      order: sanitiseOrder(orders[0]), // older clients expect a single order
      vendorCount: orders.length,
      summary: {
        subtotal: grandTotal,
        total: grandTotal,
        currency,
        symbol: sym(currency),
      },
    });

    // ── Notify each vendor about their slice ─────────────────────────
    for (const [vendorId, { vendor, lines }] of byVendor) {
      const order = orders.find((o) => String(o.vendor) === vendorId);
      if (!order) continue;
      notifyVendorOfNewOrder({
        order,
        ad: lines[0].ad,
        vendor,
        currency,
      }).catch((e) => console.error("[notifyVendorOfNewOrder]", e.message));
    }
  } catch (err) {
    console.error("[createOrder]", err);
    res.status(500).json({
      message: err.message ?? "Failed to create order",
    });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /orders/group/:groupId/pay   — one charge for the whole cart
// POST /orders/:id/pay              — single order
// ═══════════════════════════════════════════════════════════════════════
export const initOrderPayment = async (req, res) => {
  try {
    const buyerId = req.user.userId;
    const { groupId, id } = req.params;

    const orders = groupId
      ? await Order.find({ orderGroup: groupId, buyer: buyerId })
      : await Order.find({ _id: id, buyer: buyerId });

    if (orders.length === 0) {
      return res.status(404).json({ message: "Order not found" });
    }

    const payable = orders.filter((o) => o.status === "pending");
    if (payable.length === 0) {
      return res.status(409).json({
        message: "This order has already been paid for.",
        currentStatus: orders[0].status,
      });
    }

    const currency = payable[0].currency;
    const amount = money(payable.reduce((s, o) => s + o.total, 0));
    const groupRef = payable[0].orderGroup ?? String(payable[0]._id);

    const buyer = await User.findById(buyerId)
      .select("email username phone whatsapp")
      .lean();

    // Fresh ref every attempt so a failed payment can be retried cleanly
    const tx_ref = `smilebaba-order-${groupRef}-${Date.now()}`;
    await Order.updateMany(
      { _id: { $in: payable.map((o) => o._id) } },
      { $set: { flwTxRef: tx_ref } },
    );

    const frontendBase = (
      process.env.NEXT_PUBLIC_APP_URL ??
      process.env.FRONTEND_URL ??
      "https://www.smilebabahub.com"
    ).replace(/\/+$/, "");

    const payload = {
      tx_ref,
      amount,
      currency,
      redirect_url: `${frontendBase}/checkout/complete?group=${groupRef}`,
      customer: {
        email: buyer?.email ?? "customer@smilebabahub.com",
        name: buyer?.username ?? "SmileBaba Customer",
        phonenumber: buyer?.phone ?? buyer?.whatsapp ?? "0000000000",
      },
      meta: {
        purpose: "order",
        orderGroup: groupRef,
        orderIds: payable.map((o) => String(o._id)).join(","),
        orderId: String(payable[0]._id), // legacy webhook compatibility
        buyerId: String(buyerId),
        currency,
      },
      customizations: {
        title: "SmileBaba Hub",
        description:
          payable.length === 1
            ? "Your SmileBaba order"
            : `Order from ${payable.length} vendors`,
        logo: `${frontendBase}/logo.png`,
        color: "#ffc105",
      },
    };

    // Split-at-source only when a single vendor with a configured subaccount
    if (payable.length === 1 && payable[0].paymentModel === "split_at_source") {
      const vendor = await User.findById(payable[0].vendor)
        .select("flwSubaccountId")
        .lean();
      if (vendor?.flwSubaccountId) {
        payload.subaccounts = [
          {
            id: vendor.flwSubaccountId,
            transaction_split_ratio: Math.round((1 - COMMISSION_RATE) * 100),
          },
        ];
      }
    }

    const { paymentLink } = await initializeGatewayPayment({
      countryCode: countryFromCurrency(currency),
      payload,
    });

    res.status(200).json({
      paymentLink,
      link: paymentLink, // aliases — the app accepts any of these
      checkoutUrl: paymentLink,
      tx_ref,
      orderGroup: groupRef,
      orderId: String(payable[0]._id),
      amount,
      currency,
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
// POST /orders/verify   { orderGroup } or { orderId }
// ═══════════════════════════════════════════════════════════════════════
export const verifyOrderPayment = async (req, res) => {
  try {
    const { orderGroup, orderId, transaction_id } = req.body;
    const buyerId = req.user.userId;

    if (!orderGroup && !orderId) {
      return res
        .status(400)
        .json({ message: "orderGroup or orderId is required" });
    }

    const orders = orderGroup
      ? await Order.find({ orderGroup, buyer: buyerId })
      : await Order.find({ _id: orderId, buyer: buyerId });

    if (orders.length === 0) {
      return res.status(404).json({ message: "Order not found" });
    }

    const pending = orders.filter((o) => o.status === "pending");

    // Already settled — the webhook probably beat us here
    if (pending.length === 0) {
      return res.status(200).json({
        status: "paid",
        orders: orders.map(sanitiseOrder),
        order: sanitiseOrder(orders[0]),
      });
    }

    let payment;
    try {
      payment = await verifyGatewayPayment({
        countryCode: countryFromCurrency(pending[0].currency),
        transactionId: transaction_id ?? pending[0].flwTxRef,
      });
    } catch (e) {
      console.warn("[verifyOrderPayment] gateway lookup failed:", e.message);
      return res.status(200).json({
        status: "pending",
        orders: orders.map(sanitiseOrder),
        order: sanitiseOrder(orders[0]),
      });
    }

    if (payment?.status !== "successful") {
      return res.status(200).json({
        status: payment?.status === "pending" ? "pending" : "failed",
        orders: orders.map(sanitiseOrder),
        order: sanitiseOrder(orders[0]),
      });
    }

    // Amount is checked against the GROUP total, not one order.
    // Overpayment is fine (gateway fees); underpayment beyond 5% is refused.
    const expected = money(pending.reduce((s, o) => s + o.total, 0));
    const diff = Number(payment.amount) - expected;
    if (diff < 0 && Math.abs(diff) / expected > 0.05) {
      console.error("[verifyOrderPayment] underpayment", {
        paid: payment.amount,
        expected,
      });
      return res.status(400).json({
        message: "Payment amount doesn't match your order total",
      });
    }

    for (const order of pending) {
      await markOrderPaid({ order, payment });
    }

    const fresh = await Order.find({
      _id: { $in: orders.map((o) => o._id) },
    }).lean();

    res.status(200).json({
      status: "paid",
      orders: fresh.map(sanitiseOrder),
      order: sanitiseOrder(fresh[0]),
    });
  } catch (err) {
    console.error("[verifyOrderPayment]", err);
    res.status(500).json({ message: "Verification failed" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /orders/webhook — Flutterwave's confirmation.
// Register the raw-body parser for this path in server.js.
// ═══════════════════════════════════════════════════════════════════════
export const orderPaymentWebhook = async (req, res) => {
  try {
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

    // Meta arrives either as an object or an array of {metaname, metavalue}
    const rawMeta = data.meta ?? data.payment_meta ?? data.metadata ?? {};
    const meta = Array.isArray(rawMeta)
      ? rawMeta.reduce((acc, i) => ({ ...acc, [i.metaname]: i.metavalue }), {})
      : rawMeta;

    // Ignore subscription and boost webhooks that share this endpoint shape
    if (meta.purpose !== "order") return res.status(200).end();

    // Resolve the orders this charge covers — group first, then legacy id
    let orders = [];
    if (meta.orderGroup) {
      orders = await Order.find({ orderGroup: meta.orderGroup });
    } else if (meta.orderIds) {
      orders = await Order.find({
        _id: { $in: String(meta.orderIds).split(",").filter(Boolean) },
      });
    } else if (meta.orderId) {
      const one = await Order.findById(meta.orderId);
      if (one) orders = [one];
    }

    if (orders.length === 0) {
      console.warn("[orderPaymentWebhook] no orders for meta:", meta);
      return res.status(200).end();
    }

    const pending = orders.filter((o) => o.status === "pending");
    if (pending.length === 0) return res.status(200).end(); // idempotent

    const amount = Number(data.charged_amount ?? data.amount);
    const expected = money(pending.reduce((s, o) => s + o.total, 0));
    const diff = amount - expected;

    if (diff < 0 && Math.abs(diff) / expected > 0.05) {
      console.error("[orderPaymentWebhook] underpayment", {
        paid: amount,
        expected,
        orderGroup: meta.orderGroup,
      });
      return res.status(200).end();
    }

    for (const order of pending) {
      await markOrderPaid({
        order,
        payment: {
          id: data.id,
          amount,
          currency: data.currency,
          tx_ref: data.tx_ref ?? data.reference,
        },
      });
    }

    res.status(200).end();
  } catch (err) {
    console.error("[orderPaymentWebhook]", err);
    res.status(200).end(); // always 200 — never trigger a retry loop
  }
};

// ═══════════════════════════════════════════════════════════════════════
// PATCH /orders/:id/status — vendor moves their own order along
// ═══════════════════════════════════════════════════════════════════════
export const updateOrderStatus = async (req, res) => {
  try {
    const { status, note } = req.body;
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

    if (order.status === "pending" && status !== "cancelled") {
      return res.status(409).json({
        message: "This order hasn't been paid for yet.",
      });
    }

    order.status = status;
    addTimelineEntry(order, status, { actor: "vendor", note });

    if (status === "dispatched") order.shippedAt = new Date();
    if (status === "delivered") order.deliveredAt = new Date();

    // Food releases escrow when the vendor marks it delivered
    if (
      status === "delivered" &&
      order.escrowReleaseTrigger === "auto_on_delivery"
    ) {
      await releaseEscrow({ order, actor: "vendor" });
    }

    await order.save();
    res.status(200).json({ message: "Order status updated", order });

    // ── Tell the buyer ───────────────────────────────────────────────
    const [buyer, orderAd] = await Promise.all([
      User.findById(order.buyer).select("phone").lean(),
      Ad.findById(order.ad).select("category.main").lean(),
    ]);

    const isDelivery = orderAd?.category?.main === "delivery";
    const num = String(order._id).slice(-6).toUpperCase();

    const copy = {
      confirmed: {
        title: "Order confirmed",
        body: isDelivery
          ? "Your rider confirmed and will collect your item soon."
          : "The vendor is preparing your order.",
        sms: isDelivery
          ? `SmileBaba: Your rider has confirmed! They will collect your item soon.`
          : `SmileBaba: Your order ${num} has been confirmed. The vendor will deliver soon.`,
      },
      dispatched: {
        title: "On the way",
        body: "Your order has been sent out for delivery.",
        sms: `SmileBaba: Order ${num} is on the way! Track it in the app.`,
      },
      delivered: {
        title: "Delivered",
        body: "Confirm you've received it to release payment to the vendor.",
        sms: `SmileBaba: Order ${num} delivered. Confirm in the app to release payment.`,
      },
      cancelled: {
        title: "Order cancelled",
        body: note ?? "Contact support if this is unexpected.",
        sms: `SmileBaba: Order ${num} was cancelled. Contact support if unexpected.`,
      },
    }[status];

    notify({
      userId: order.buyer,
      type: "boost_approved", // reuse until an order type exists on the enum
      title: copy.title,
      message: copy.body,
      actionUrl: `/orders/${order._id}`,
      actionLabel: "Track order",
      dedupeKey: `order-${order._id}-${status}`,
      data: { orderId: String(order._id), status },
    }).catch(() => {});

    if (buyer?.phone) {
      sendSMS(buyer.phone, copy.sms).catch((e) =>
        console.error("[SMS]", e.message),
      );
    }
  } catch (err) {
    console.error("[updateOrderStatus]", err);
    res.status(500).json({ message: "Failed to update order" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /orders/:id/confirm-delivery — buyer releases this vendor's escrow
// ═══════════════════════════════════════════════════════════════════════
export const confirmDelivery = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (String(order.buyer) !== String(req.user.userId)) {
      return res.status(403).json({ message: "Not authorised" });
    }

    if (!["dispatched", "confirmed", "delivered"].includes(order.status)) {
      return res.status(409).json({
        message: `Can't confirm delivery when status is "${order.status}"`,
      });
    }

    if (order.escrowStatus === "released") {
      return res.status(200).json({
        message: "Already confirmed.",
        order: sanitiseOrder(order),
      });
    }

    order.status = "delivered";
    order.deliveredAt = order.deliveredAt ?? new Date();
    order.deliveryConfirmedAt = new Date();
    order.deliveryConfirmedBy = "buyer";
    addTimelineEntry(order, "completed", { actor: "buyer" });

    if (order.escrowStatus === "held") {
      await releaseEscrow({ order, actor: "buyer" });
    }

    await order.save();

    res.status(200).json({
      message: "Delivery confirmed. The vendor has been paid.",
      order: sanitiseOrder(order),
    });

    notify({
      userId: order.vendor,
      type: "boost_approved",
      title: "Payment released",
      message: `Buyer confirmed delivery. ${sym(order.currency)}${order.vendorPayout.toLocaleString()} added to your balance.`,
      actionUrl: "/vendor/dashboard",
      actionLabel: "View earnings",
      dedupeKey: `order-${order._id}-released`,
      data: { orderId: String(order._id) },
    }).catch(() => {});
  } catch (err) {
    console.error("[confirmDelivery]", err);
    res.status(500).json({ message: "Failed to confirm delivery" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /orders/:id/refund — buyer requests, vendor resolves
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

    if (order.refundRequestedAt) {
      return res.status(409).json({
        message: "You've already requested a refund on this order.",
      });
    }

    if (!isRefundEligible(order.refundPolicy, order.status)) {
      return res.status(409).json({
        message:
          "This order isn't eligible for a refund under the vendor's policy.",
      });
    }

    // Window policy — enforce the day count against delivery
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
    addTimelineEntry(order, "refund_requested", {
      actor: "buyer",
      note: reason,
    });
    await order.save();

    res.status(200).json({
      message: "Refund request sent to the vendor",
      order: sanitiseOrder(order),
    });

    notify({
      userId: order.vendor,
      type: "boost_approved",
      title: "Refund requested",
      message: `A buyer requested a refund. Reason: ${reason}. Review it from your dashboard.`,
      actionUrl: "/vendor/orders",
      actionLabel: "Review refund",
      dedupeKey: `order-${order._id}-refund-requested`,
      data: { orderId: String(order._id) },
    }).catch(() => {});
  } catch (err) {
    console.error("[requestRefund]", err);
    res.status(500).json({ message: "Failed to request refund" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /orders/:id/dispute — freezes the payout, admin resolves
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

    order.escrowStatus = "disputed";
    order.refundReason = reason;
    order.refundNotes = notes ?? "";
    order.refundRequestedAt = new Date();
    addTimelineEntry(order, "disputed", { actor: "buyer", note: reason });
    await order.save();

    // Freeze the money too — a pending ledger row must not become available
    await VendorLedger.updateMany(
      { order: order._id, type: "sale", status: "pending" },
      { $set: { notes: "Frozen — order disputed" } },
    );

    res.status(200).json({
      message:
        "We've received your report. Support will reach out within 24 hours.",
      order: sanitiseOrder(order),
    });

    const adminEmails = (process.env.ADMIN_EMAILS ?? "")
      .split(",")
      .filter(Boolean);
    console.error(
      `[dispute] Order ${order._id} disputed. Reason: ${reason}. ` +
        `Amount: ${sym(order.currency)}${order.total}. ` +
        `Notify: ${adminEmails.join(", ") || "(ADMIN_EMAILS not set)"}`,
    );
  } catch (err) {
    console.error("[reportDispute]", err);
    res.status(500).json({ message: "Failed to report problem" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// INTERNAL
// ═══════════════════════════════════════════════════════════════════════

/** Mark one order paid and write its ledger row. Idempotent. */
async function markOrderPaid({ order, payment }) {
  if (order.status !== "pending") return;

  order.status = "confirmed";
  order.paidAt = new Date();
  order.flwTxId = String(payment.id ?? "");
  addTimelineEntry(order, "paid", { actor: "system" });

  if (order.paymentModel === "split_at_source") {
    // Flutterwave already sent the vendor's share at charge time
    order.escrowStatus = "released";
    order.escrowReleasedAt = new Date();

    await VendorLedger.create({
      vendor: order.vendor,
      amount: order.vendorPayout,
      currency: order.currency,
      order: order._id,
      type: "sale",
      status: "paid_out",
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

  const num = String(order._id).slice(-6).toUpperCase();

  notify({
    userId: order.buyer,
    type: "boost_approved",
    title: "Payment confirmed",
    message: "Your order is confirmed and the vendor has been notified.",
    actionUrl: `/orders/${order._id}`,
    actionLabel: "Track order",
    dedupeKey: `order-${order._id}-paid`,
    data: { orderId: String(order._id), status: "paid" },
  }).catch(() => {});

  notify({
    userId: order.vendor,
    type: "boost_approved",
    title: "New paid order",
    message: `${sym(order.currency)}${order.total.toLocaleString()} paid for order ${num}. Start preparing.`,
    actionUrl: "/vendor/orders",
    actionLabel: "View orders",
    dedupeKey: `order-${order._id}-vendor-paid`,
    data: { orderId: String(order._id) },
  }).catch(() => {});
}

/** Flip this order's held escrow to available in the vendor ledger. */
async function releaseEscrow({ order, actor }) {
  if (order.escrowStatus !== "held") return;

  order.escrowStatus = "released";
  order.escrowReleasedAt = new Date();
  if (!order.deliveryConfirmedAt) {
    order.deliveryConfirmedAt = new Date();
    order.deliveryConfirmedBy = actor;
  }

  // Scoped to this order — a sibling order in the same group is untouched
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

  const itemCount = (order.items ?? []).length;
  const itemLabel = itemCount > 1 ? `${itemCount} items` : `"${ad.title}"`;

  if (vendorFull?.phone) {
    const isDelivery = ad.category?.main === "delivery";
    const smsBody = isDelivery
      ? `SmileBaba: New delivery booking! ${sym(currency)}${order.total.toLocaleString()}. ` +
        `Route: ${String(order.deliveryAddress || "").slice(0, 80)}. ` +
        `Confirm: https://smilebabahub.com/vendor/orders`
      : `SmileBaba: New order for ${itemLabel} — ${sym(currency)}${order.total.toLocaleString()}. ` +
        `Log in to confirm: https://smilebabahub.com/vendor/orders`;
    sendSMS(vendorFull.phone, smsBody).catch(() => {});
  }

  await notify({
    userId: vendor._id,
    type: "boost_approved",
    title: "New order",
    message: `${sym(currency)}${order.total.toLocaleString()} — awaiting payment confirmation.`,
    actionUrl: "/vendor/orders",
    actionLabel: "View order",
    dedupeKey: `order-${order._id}-placed`,
    data: { orderId: String(order._id) },
  });
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
    orderGroup: raw.orderGroup ?? null,
    items: raw.items ?? [],
    subtotal: raw.total ?? 0,
    total: raw.total ?? 0,
    commissionAmount: raw.commissionAmount ?? 0,
    vendorPayout: raw.vendorPayout ?? 0,
    currency: raw.currency ?? "GHS",
    symbol: sym(raw.currency ?? "GHS"),
    status: raw.status ?? "pending",
    statusLabel: statusSummary(raw),
    timeline: raw.timeline ?? [],
    journey: buildJourney(raw),
    paymentModel: raw.paymentModel,
    escrowStatus: raw.escrowStatus,
    refundEligible: isRefundEligible(raw.refundPolicy, raw.status ?? "pending"),
    refundPolicy: raw.refundPolicy,
    deliveryAddress: parseAddress(raw.deliveryAddress),
    paidAt: raw.paidAt,
    shippedAt: raw.shippedAt,
    deliveredAt: raw.deliveredAt ?? raw.deliveryConfirmedAt,
    refundRequestedAt: raw.refundRequestedAt ?? null,
    flwTxRef: raw.flwTxRef,
    createdAt: raw.createdAt,
  };
}
