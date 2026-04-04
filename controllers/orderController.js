// controllers/orderController.js
// Handles marketplace and food orders placed by buyers.
// Orders are created when a buyer purchases a product from a vendor's ad.
//
// Schema fields (stored in Order model):
//   buyer       — User ref
//   vendor      — User ref (ad owner)
//   ad          — Ad ref
//   items       — [{ name, qty, price }]
//   total       — number
//   currency    — "GHS" | "NGN"
//   status      — "pending" | "confirmed" | "delivered" | "cancelled"
//   deliveryAddress — string
//   txRef       — payment reference
//   createdAt

import Order from "../models/orderModel.js";
import Ad from "../models/adModel.js";

// ── GET /orders/my ─────────────────────────────────────────────────────────
// Returns all orders placed BY the logged-in user (as a buyer).
export const getMyOrders = async (req, res) => {
  try {
    const userId = req.user.userId;

    const orders = await Order.find({ buyer: userId })
      .sort({ createdAt: -1 })
      .populate("vendor", "username")
      .populate("ad", "title")
      .lean();

    const serialized = orders.map((o) => ({
      _id: String(o._id),
      items: o.items ?? [],
      total: o.total ?? 0,
      currency: o.currency ?? "GHS",
      status: o.status ?? "pending",
      vendor: o.vendor?.username ?? "Unknown vendor",
      deliveryAddress: o.deliveryAddress ?? "",
      createdAt: o.createdAt,
    }));

    res.status(200).json({ orders: serialized });
  } catch (error) {
    console.error("getMyOrders error:", error);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
};

// ── POST /orders ────────────────────────────────────────────────────────────
// Create a new order after payment confirmation.
export const createOrder = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { adId, items, total, currency, deliveryAddress, txRef } = req.body;

    if (!adId || !items?.length || !total || !currency) {
      return res.status(400).json({ message: "Missing required order fields" });
    }

    // Look up vendor from the ad
    const ad = await Ad.findById(adId).select("postedBy");
    if (!ad) return res.status(404).json({ message: "Ad not found" });

    const order = await Order.create({
      buyer: userId,
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
  } catch (error) {
    console.error("createOrder error:", error);
    res.status(500).json({ message: "Failed to create order" });
  }
};

// ── PATCH /orders/:id/status ────────────────────────────────────────────────
// Vendor confirms, delivers, or cancels an order.
export const updateOrderStatus = async (req, res) => {
  try {
    const { status } = req.body;
    const valid = ["confirmed", "delivered", "cancelled"];
    if (!valid.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found" });

    // Only the vendor of this order can update it
    if (String(order.vendor) !== req.user.userId) {
      return res.status(403).json({ message: "Not authorised" });
    }

    order.status = status;
    await order.save();

    res.status(200).json({ message: "Order status updated", order });
  } catch (error) {
    console.error("updateOrderStatus error:", error);
    res.status(500).json({ message: "Failed to update order" });
  }
};
