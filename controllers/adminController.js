// controllers/adminController.js
import User     from "../models/user.js";
import Purchase from "../models/purchaseModel.js";
import Marketer from "../models/marketerModel.js";
import Ad       from "../models/adModel.js";
import Stats    from "../models/statsModel.js";

// ── Helpers ───────────────────────────────────────────────────────────────
const parsePage  = (q) => Math.max(1, parseInt(q ?? "1",  10));
const parseLimit = (q) => Math.min(100, Math.max(1, parseInt(q ?? "20", 10)));

// ── GET /admin/overview ────────────────────────────────────────────────────
// Dashboard headline stats
export const getOverview = async (req, res) => {
  try {
    const country = req.query.country;   // "Ghana" | "Nigeria" | undefined (all)

    const [
      totalUsers,
      totalVendors,
      totalAdmins,
      totalAds,
      totalMarketers,
      revenueGHS,
      revenueNGN,
      recentUsers,
      recentPurchases,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ role: "vendor" }),
      User.countDocuments({ role: "admin" }),
      Ad.countDocuments({ isActive: true }),
      Marketer.countDocuments({ isActive: true }),

      // Revenue — successful purchases only
      Purchase.aggregate([
        { $match: { status: "successful", currency: "GHS" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      Purchase.aggregate([
        { $match: { status: "successful", currency: "NGN" } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),

      // Last 5 signups
      User.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .select("username email role createdAt")
        .lean(),

      // Last 5 successful payments
      Purchase.find({ status: "successful" })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate("user", "username email")
        .select("title amount currency createdAt user")
        .lean(),
    ]);

    res.status(200).json({
      stats: {
        totalUsers,
        totalVendors,
        totalAdmins,
        totalAds,
        totalMarketers,
        revenueGHS: revenueGHS[0]?.total ?? 0,
        revenueNGN: revenueNGN[0]?.total ?? 0,
      },
      recentUsers,
      recentPurchases,
    });
  } catch (error) {
    console.error("getOverview error:", error);
    res.status(500).json({ message: "Failed to load overview" });
  }
};

// ── GET /admin/users ───────────────────────────────────────────────────────
// Paginated user list with search + role filter
export const getUsers = async (req, res) => {
  try {
    const page   = parsePage(req.query.page);
    const limit  = parseLimit(req.query.limit);
    const skip   = (page - 1) * limit;
    const search = req.query.search?.trim();
    const role   = req.query.role;       // "guest" | "vendor" | "admin" | undefined

    const filter = {};
    if (role) filter.role = role;
    if (search) {
      filter.$or = [
        { username: { $regex: search, $options: "i" } },
        { email:    { $regex: search, $options: "i" } },
        { phone:    { $regex: search, $options: "i" } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("-password -loginHistory")
        .lean(),
      User.countDocuments(filter),
    ]);

    res.status(200).json({
      users,
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("getUsers error:", error);
    res.status(500).json({ message: "Failed to fetch users" });
  }
};

// ── GET /admin/users/:id ──────────────────────────────────────────────────
export const getUserDetail = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .select("-password")
      .lean();
    if (!user) return res.status(404).json({ message: "User not found" });

    // Their purchase history
    const purchases = await Purchase.find({ user: req.params.id, status: "successful" })
      .sort({ createdAt: -1 })
      .select("title amount currency createdAt txRef")
      .lean();

    // Their active ads
    const ads = await Ad.find({ postedBy: req.params.id, isActive: true })
      .sort({ createdAt: -1 })
      .select("title price category boost createdAt")
      .lean();

    res.status(200).json({ user, purchases, ads });
  } catch (error) {
    console.error("getUserDetail error:", error);
    res.status(500).json({ message: "Failed to fetch user" });
  }
};

// ── PATCH /admin/users/:id/role ───────────────────────────────────────────
// Manually set a user's role (e.g. suspend → guest, grant vendor)
export const setUserRole = async (req, res) => {
  try {
    const { role } = req.body;
    if (!["guest", "vendor", "admin"].includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }
    const user = await User.findByIdAndUpdate(
      req.params.id, { role }, { new: true }
    ).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.status(200).json({ message: "Role updated", user });
  } catch (error) {
    res.status(500).json({ message: "Failed to update role" });
  }
};

// ── GET /admin/subscriptions ──────────────────────────────────────────────
// All successful purchases/subscriptions
export const getSubscriptions = async (req, res) => {
  try {
    const page     = parsePage(req.query.page);
    const limit    = parseLimit(req.query.limit);
    const skip     = (page - 1) * limit;
    const search   = req.query.search?.trim();
    const currency = req.query.currency;   // "GHS" | "NGN"
    const planId   = req.query.planId;

    const filter = { status: "successful" };
    if (currency) filter.currency = currency;
    if (planId)   filter.planId   = planId;

    // If searching, match user first
    if (search) {
      const matchedUsers = await User.find({
        $or: [
          { username: { $regex: search, $options: "i" } },
          { email:    { $regex: search, $options: "i" } },
        ],
      }).select("_id").lean();
      filter.user = { $in: matchedUsers.map((u) => u._id) };
    }

    const [purchases, total] = await Promise.all([
      Purchase.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("user", "username email phone")
        .lean(),
      Purchase.countDocuments(filter),
    ]);

    // Revenue summary for the filtered set
    const revenuePipeline = [
      { $match: filter },
      { $group: {
        _id:       "$currency",
        total:     { $sum: "$amount" },
        count:     { $sum: 1 },
      }},
    ];
    const revenueByCurrency = await Purchase.aggregate(revenuePipeline);

    res.status(200).json({
      purchases,
      meta:     { page, limit, total, pages: Math.ceil(total / limit) },
      revenue:  revenueByCurrency,
    });
  } catch (error) {
    console.error("getSubscriptions error:", error);
    res.status(500).json({ message: "Failed to fetch subscriptions" });
  }
};

// ── GET /admin/marketers ──────────────────────────────────────────────────
export const getMarketers = async (req, res) => {
  try {
    const page   = parsePage(req.query.page);
    const limit  = parseLimit(req.query.limit);
    const skip   = (page - 1) * limit;
    const search = req.query.search?.trim();

    const filter = {};
    if (search) {
      filter.$or = [
        { name:         { $regex: search, $options: "i" } },
        { email:        { $regex: search, $options: "i" } },
        { referralCode: { $regex: search, $options: "i" } },
      ];
    }

    const [marketers, total] = await Promise.all([
      Marketer.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("-password")
        .lean(),
      Marketer.countDocuments(filter),
    ]);

    // Total earnings across all marketers
    const totals = await Marketer.aggregate([
      { $group: {
        _id:              null,
        totalEarningsGHS: { $sum: "$totalEarningsGHS" },
        totalEarningsNGN: { $sum: "$totalEarningsNGN" },
        pendingGHS:       { $sum: "$pendingPayoutGHS" },
        pendingNGN:       { $sum: "$pendingPayoutNGN" },
        totalReferrals:   { $sum: "$totalReferrals"   },
      }},
    ]);

    res.status(200).json({
      marketers,
      meta:   { page, limit, total, pages: Math.ceil(total / limit) },
      totals: totals[0] ?? {},
    });
  } catch (error) {
    console.error("getMarketers error:", error);
    res.status(500).json({ message: "Failed to fetch marketers" });
  }
};

// ── PATCH /admin/marketers/:id/payout ────────────────────────────────────
// Mark all pending commissions as paid out
export const markMarketerPaidOut = async (req, res) => {
  try {
    const { currency } = req.body;   // "GHS" | "NGN"
    if (!["GHS", "NGN"].includes(currency)) {
      return res.status(400).json({ message: "currency must be GHS or NGN" });
    }
    const pendingField = currency === "NGN" ? "pendingPayoutNGN" : "pendingPayoutGHS";

    await Marketer.findByIdAndUpdate(req.params.id, {
      [pendingField]:  0,
      "commissions.$[elem].paidOut": true,
    }, {
      arrayFilters: [{ "elem.paidOut": false, "elem.currency": currency }],
    });

    res.status(200).json({ message: "Marked as paid out" });
  } catch (error) {
    res.status(500).json({ message: "Failed to update payout" });
  }
};

// ── GET /admin/ads ────────────────────────────────────────────────────────
export const getAds = async (req, res) => {
  try {
    const page     = parsePage(req.query.page);
    const limit    = parseLimit(req.query.limit);
    const skip     = (page - 1) * limit;
    const search   = req.query.search?.trim();
    const category = req.query.category;
    const boosted  = req.query.boosted;

    const filter = {};
    if (category)           filter["category.main"] = category;
    if (boosted === "true") filter["boost.isBoosted"] = true;
    if (search) {
      filter.$or = [
        { title:       { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    const [ads, total] = await Promise.all([
      Ad.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("postedBy", "username email")
        .select("title category price boost isActive isSold createdAt postedBy")
        .lean(),
      Ad.countDocuments(filter),
    ]);

    res.status(200).json({
      ads,
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to fetch ads" });
  }
};

// ── GET /admin/stats/trend ────────────────────────────────────────────────
// Returns last N days of daily snapshots for trend charts.
// Used by admin dashboard to show revenue / users / ads over time.
export const getStatsTrend = async (req, res) => {
  try {
    const country = req.query.country ?? "Ghana";
    const days    = Math.min(90, Math.max(7, parseInt(req.query.days ?? "30", 10)));

    // Build date range
    const dates = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().split("T")[0]);
    }

    const snapshots = await Stats.find({
      country,
      date: { $in: dates },
    }).sort({ date: 1 }).lean();

    // Fill gaps with zeros so charts don't skip days
    const map = Object.fromEntries(snapshots.map((s) => [s.date, s]));
    const trend = dates.map((date) => map[date] ?? {
      date,
      country,
      newUsers:       0,
      totalVendors:   0,
      newAds:         0,
      revenueGHS:     0,
      revenueNGN:     0,
      totalViews:     0,
      totalContacts:  0,
    });

    res.status(200).json({ trend, days, country });
  } catch (error) {
    console.error("getStatsTrend error:", error);
    res.status(500).json({ message: "Failed to fetch stats" });
  }
};

// ── GET /admin/stats/conversion ───────────────────────────────────────────
// Top ads by conversion rate (contactClicks / views).
// Helps admins identify high-performing listings and advise vendors.
export const getConversionStats = async (req, res) => {
  try {
    const country = req.query.country;
    const limit   = parseLimit(req.query.limit ?? "20");

    const filter = { isActive: true, views: { $gt: 0 } };
    if (country) filter["location.country"] = country;

    const ads = await Ad.find(filter)
      .select("title category price views contactClicks postedBy boost location")
      .populate("postedBy", "username")
      .sort({ views: -1 })
      .limit(limit * 5)    // fetch more then sort in-memory for accuracy
      .lean();

    // Compute conversion rate and sort
    const withRate = ads
      .map((ad) => ({
        _id:            ad._id,
        title:          ad.title,
        category:       ad.category?.main,
        country:        ad.location?.country,
        vendor:         (ad.postedBy )?.username ?? "—",
        views:          ad.views ?? 0,
        contacts:       ad.contactClicks ?? 0,
        conversionRate: ad.views > 0
          ? +((ad.contactClicks / ad.views) * 100).toFixed(1)
          : 0,
        isBoosted:      ad.boost?.isBoosted ?? false,
      }))
      .sort((a, b) => b.conversionRate - a.conversionRate)
      .slice(0, limit);

    res.status(200).json({ ads: withRate });
  } catch (error) {
    console.error("getConversionStats error:", error);
    res.status(500).json({ message: "Failed to fetch conversion stats" });
  }
};