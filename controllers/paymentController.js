import axios from "axios";
import User from "../models/user.js";
import { PRICING } from "../config/pricing.js";

// INITIALIZE PAYMENT

export const initializePayment = async (req, res) => {
  try {
    const { planId, billingCycle, currency } = req.body;

    const userId = req.user.userId;

    // Validate plan
    const plan = PRICING[planId];

    if (!plan) {
      return res.status(400).json({
        message: "Invalid plan selected",
      });
    }

    const cycle = plan[billingCycle];

    if (!cycle) {
      return res.status(400).json({
        message: "Invalid billing cycle",
      });
    }

    const amount = cycle[currency];

    if (!amount) {
      return res.status(400).json({
        message: "Unsupported currency",
      });
    }

    // Get user
    const existingUser = await User.findById(userId);

    if (!existingUser) {
      return res.status(404).json({
        message: "User not found",
      });
    }

    // Generate transaction reference

    const tx_ref = `smilebaba-${userId}-${Date.now()}`;

    const response = await axios.post(
      "https://api.flutterwave.com/v3/payments",
      {
        tx_ref,
        amount,
        currency,

        redirect_url: "http://localhost:3000/payment-success",

        customer: {
          email: existingUser.email,
          name: existingUser.name,
          phonenumber: existingUser.phone,
        },

        // VERY IMPORTANT

        meta: {
          userId,
          planId,
          billingCycle,
        },

        customizations: {
          title: "SmileBaba Subscription",
          description: `${planId} ${billingCycle} subscription`,
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
        },
      },
    );

    res.status(200).json({
      paymentLink: response.data.data.link,
    });
  } catch (error) {
    console.log(error.response?.data || error.message);

    res.status(500).json({
      message: "Payment initialization failed",
    });
  }
};

// VERIFY PAYMENT (Redirect Verification)

export const verifyPayment = async (req, res) => {
  try {
    const { transaction_id } = req.query;

    const response = await axios.get(
      `https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`,
      {
        headers: {
          Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`,
        },
      },
    );

    const payment = response.data.data;

    if (payment.status !== "successful") {
      return res.status(400).json({
        message: "Payment not successful",
      });
    }

    const { userId, planId, billingCycle } = payment.meta;

    const expectedAmount = PRICING[planId][billingCycle][payment.currency];

    // ANTI-FRAUD CHECK

    if (payment.amount !== expectedAmount) {
      return res.status(400).json({
        message: "Amount mismatch detected",
      });
    }

    // UPDATE USER SUBSCRIPTION

    const now = new Date();

    const expiresAt =
      billingCycle === "monthly"
        ? new Date(now.setMonth(now.getMonth() + 1))
        : new Date(now.setFullYear(now.getFullYear() + 1));

    await User.findByIdAndUpdate(userId, {
      role: "registered",
      subscription: {
        plan: planId,
        billingCycle,
        price: payment.amount,
        startedAt: new Date(),
        expiresAt,
      },
    });

    // Redirect user
    res.redirect("http://localhost:3000/dashboard");
  } catch (error) {
    console.log(error);

    res.status(500).json({
      message: "Payment verification failed",
    });
  }
};

// WEBHOOK (PRODUCTION MUST HAVE)

export const flutterwaveWebhook = async (req, res) => {
  try {
    const secretHash = process.env.FLW_WEBHOOK_SECRET;

    const signature = req.headers["verif-hash"];

    if (!signature || signature !== secretHash) {
      return res.status(401).end();
    }

    const payload = req.body;

    if (
      payload.event === "charge.completed" &&
      payload.data.status === "successful"
    ) {
      const payment = payload.data;

      const { userId, planId, billingCycle } = payment.meta;

      const expectedAmount = PRICING[planId][billingCycle][payment.currency];

      if (payment.amount !== expectedAmount) {
        return res.status(400).end();
      }

      const now = new Date();

      const expiresAt =
        billingCycle === "monthly"
          ? new Date(now.setMonth(now.getMonth() + 1))
          : new Date(now.setFullYear(now.getFullYear() + 1));

      await User.findByIdAndUpdate(userId, {
        role: "registered",
        subscription: {
          plan: planId,
          billingCycle,
          price: payment.amount,
          startedAt: new Date(),
          expiresAt,
        },
      });
    }

    res.status(200).end();
  } catch (error) {
    console.log(error);
    res.status(500).end();
  }
};
