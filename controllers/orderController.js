// controllers/orderController.js
import Order from "../models/orderModel.js";
import Ad from "../models/adModel.js";
import User from "../models/user.js";
import { sendSMS } from "../lib/smsService.js";

// ── GET /orders/my — buyer's orders ────────────────────────────────────────
export const getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ buyer: req.user.userId })
      .sort({ createdAt: -1 })
      .populate("vendor", "username")
      .populate("ad", "title")
      .lean();

    res.status(200).json({
      orders: orders.map((o) => ({
        _id: String(o._id),
        items: o.items ?? [],
        total: o.total ?? 0,
        currency: o.currency ?? "GHS",
        status: o.status ?? "pending",
        vendor: o.vendor?.username ?? "Unknown vendor",
        deliveryAddress: o.deliveryAddress ?? "",
        createdAt: o.createdAt,
      })),
    });
  } catch (err) {
    console.error("getMyOrders error:", err);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
};

// ── GET /orders/vendor — vendor's received orders ──────────────────────────
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
        currency: o.currency ?? "GHS",
        status: o.status ?? "pending",
        buyer: o.buyer?.username ?? "Customer",
        buyerPhone: o.buyer?.phone ?? "",
        adTitle: o.ad?.title ?? "",
        deliveryAddress: o.deliveryAddress ?? "",
        createdAt: o.createdAt,
      })),
      meta: { total, page: Number(page), limit: Number(limit) },
    });
  } catch (err) {
    console.error("getVendorOrders error:", err);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
};

// ── POST /orders ────────────────────────────────────────────────────────────
export const createOrder = async (req, res) => {
  try {
    const buyerId = req.user.userId;
    const { adId, items, total, currency, deliveryAddress, txRef } = req.body;

    if (!adId || !items?.length || !total || !currency) {
      return res.status(400).json({ message: "Missing required order fields" });
    }

    const ad = await Ad.findById(adId).select("postedBy title");
    if (!ad) return res.status(404).json({ message: "Ad not found" });

    const order = await Order.create({
      buyer: buyerId,
      vendor: ad.postedBy,
      ad: adId,
      items,
      total,
      currency,
      deliveryAddress,
      txRef,
      status: "pending",
    });

    res.status(201).json({ message: "Order placed successfully", order });

    // ── SMS to vendor (non-blocking) ──────────────────────────────────────
    const sym = currency === "NGN" ? "₦" : "₵";
    const vendor = await User.findById(ad.postedBy)
      .select("phone username")
      .lean();
    if (vendor?.phone) {
      sendSMS(
        vendor.phone,
        `SmileBaba: New order for "${ad.title}" — ${sym}${Number(total).toLocaleString()}. ` +
          `Log in to confirm: https://smilebabahub.com/vendor/orders`,
      ).catch((e) => console.error("[SMS order]", e.message));
    }
  } catch (err) {
    console.error("createOrder error:", err);
    res.status(500).json({ message: "Failed to create order" });
  }
};

// ── PATCH /orders/:id/status ────────────────────────────────────────────────
export const updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ["confirmed", "delivered", "cancelled"];
    if (!valid.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    if (String(order.vendor) !== req.user.userId) {
      return res.status(403).json({ message: "Not authorised" });
    }

    order.status = status;
    await order.save();

    res.status(200).json({ message: "Order status updated", order });

    // ── SMS to buyer on status change ──────────────────────────────────────
    const buyer = await User.findById(order.buyer).select("phone").lean();
    if (buyer?.phone) {
      const msgs = {
        confirmed: `SmileBaba: Your order has been confirmed! The vendor will deliver soon.`,
        delivered: `SmileBaba: Your order has been delivered. Enjoy! 🎉`,
        cancelled: `SmileBaba: Your order was cancelled. Contact support if this is unexpected.`,
      };
      sendSMS(buyer.phone, msgs[status]).catch((e) =>
        console.error("[SMS order status]", e.message),
      );
    }
  } catch (err) {
    console.error("updateOrderStatus error:", err);
    res.status(500).json({ message: "Failed to update order" });
  }
};
