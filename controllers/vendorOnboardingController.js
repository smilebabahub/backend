// controllers/vendorOnboardingController.js
//
// Vendor onboarding.
//
// Each step writes straight through to the User fields that already
// exist — storeName, storeCategory, businessType, role. The onboarding
// document only tracks progress, so nothing here becomes a second source
// of truth for data the rest of the app already reads.
//
// ─── THE TWO THINGS THAT WOULD HAVE BROKEN QUIETLY ───────────────────
//
// businessType is an enum: ["individual", "registered", "enterprise", ""].
// updateOne doesn't run validators by default, so a friendly label like
// "Sole proprietor" would have saved and then failed everywhere that
// reads it. BUSINESS_TYPES below maps labels to valid values.
//
// storeSlug was never generated. Without it /vendors/[slug] can't resolve
// for any new vendor, and nothing would have told you — the storefront
// would just 404.

import VendorOnboarding from "../models/vendorOnboardingModel.js";
import User from "../models/user.js";
import Ad from "../models/adModel.js";
import { notify } from "../lib/notify.js";

const COMMISSION_RATE = 0.05;

const clean = (v, max = 500) =>
  typeof v === "string" ? v.trim().slice(0, max) : undefined;

/**
 * Friendly label to the value User.businessType actually accepts.
 * Anything unrecognised falls back to "individual", which is both the
 * schema default and the truthful answer for most sellers.
 */
const BUSINESS_TYPES = {
  "sole proprietor": "individual",
  "individual seller": "individual",
  individual: "individual",
  "registered company": "registered",
  registered: "registered",
  partnership: "registered",
  enterprise: "enterprise",
};

const toBusinessType = (label) =>
  BUSINESS_TYPES[
    String(label ?? "")
      .toLowerCase()
      .trim()
  ] ?? "individual";

/**
 * A URL-safe, unique store slug.
 *
 * storeSlug has a sparse unique index, so a collision throws on save
 * rather than silently overwriting. Suffixing on collision is cheap and
 * means a second "Doe Electronics" still gets a working storefront.
 */
async function makeStoreSlug(name, userId) {
  const base =
    String(name ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "store";

  let slug = base;
  let n = 1;

  while (await User.exists({ storeSlug: slug, _id: { $ne: userId } })) {
    n += 1;
    slug = `${base}-${n}`;
    if (n > 50) {
      // Give up guessing and use something certain to be free
      slug = `${base}-${String(userId).slice(-6)}`;
      break;
    }
  }

  return slug;
}

// ═══════════════════════════════════════════════════════════════════════
// Derive a record for an account that predates this flow.
// ═══════════════════════════════════════════════════════════════════════
async function deriveFromUser(userId) {
  const user = await User.findById(userId)
    .select("username role storeName storeSlug storeCategory subscription")
    .lean();

  if (!user) return null;

  const plan = user.subscription?.plan;
  const hasPaidPlan =
    plan &&
    plan !== "Basic" &&
    (!user.subscription?.expiresAt ||
      new Date(user.subscription.expiresAt) > new Date());

  const listingCount = await Ad.countDocuments({ postedBy: userId });

  const isExistingVendor =
    !!user.storeName ||
    hasPaidPlan ||
    listingCount > 0 ||
    user.role === "vendor";

  if (!isExistingVendor) {
    // A genuinely new account. Empty record, they go through the flow.
    return VendorOnboarding.create({
      user: userId,
      status: "not_started",
      step: 2,
    });
  }

  // An established vendor. Complete, never asked to prove it again.
  //
  // Backfill a slug if they've been selling without one — that's the
  // difference between their storefront working and 404ing.
  if (user.storeName && !user.storeSlug) {
    const slug = await makeStoreSlug(user.storeName, userId);
    await User.updateOne({ _id: userId }, { $set: { storeSlug: slug } });
  }

  return VendorOnboarding.create({
    user: userId,
    chosenType: "vendor",
    // We don't know which surfaces they sell on, so assume the broadest
    // rather than restricting an account that already works
    services: ["marketplace"],
    acknowledgedCommission: true,
    acknowledgedAt: new Date(),
    acknowledgedRate: COMMISSION_RATE,
    wantsSubscription: !!hasPaidPlan,
    status: "complete",
    step: 7,
    completedAt: new Date(),
    grandfathered: true,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// GET /onboarding/me
// ═══════════════════════════════════════════════════════════════════════
export const getMyOnboarding = async (req, res) => {
  try {
    let record = await VendorOnboarding.findOne({ user: req.user.userId });
    if (!record) record = await deriveFromUser(req.user.userId);
    if (!record) return res.status(404).json({ message: "Account not found" });

    // The flow reads current values back from User, so someone who edits
    // their store in settings and returns here sees what they changed
    const user = await User.findById(req.user.userId)
      .select(
        "role phone country storeName storeCategory storeDescription " +
          "storeAddress storeWebsite businessType",
      )
      .lean();

    const missing = computeMissing(user, record);

    res.status(200).json({
      onboarding: {
        status: record.status,
        step: record.step,
        chosenType: record.chosenType,
        services: record.services ?? [],
        acknowledgedCommission: record.acknowledgedCommission,
        wantsSubscription: record.wantsSubscription,
        grandfathered: record.grandfathered,
        completedAt: record.completedAt,
      },
      // Prefilled so the screens don't ask for what's already known
      values: {
        phone: user?.phone ?? "",
        country: user?.country ?? "Ghana",
        name: user?.storeName ?? "",
        category: user?.storeCategory ?? "",
        description: user?.storeDescription ?? "",
        address: user?.storeAddress ?? "",
        website: user?.storeWebsite ?? "",
        businessType: user?.businessType ?? "individual",
      },
      missing,
      canComplete: missing.length === 0,
      commissionRate: COMMISSION_RATE,
      needsOnboarding:
        record.status !== "complete" && record.chosenType !== "guest",
    });
  } catch (err) {
    console.error("[getMyOnboarding]", err);
    res.status(500).json({ message: "Couldn't load your details" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// PATCH /onboarding/step/:step
//
//   2  Basic information     → User.phone, User.country
//   3  Account type          → User.role
//   4  Business details      → User.store*, User.businessType, storeSlug
//   5  Services              → User.vendorServices
//   6  Commission            → User.commissionAcknowledgedAt
// ═══════════════════════════════════════════════════════════════════════
export const saveStep = async (req, res) => {
  try {
    const step = parseInt(req.params.step, 10);
    if (!Number.isFinite(step) || step < 2 || step > 7) {
      return res.status(400).json({ message: "Invalid step" });
    }

    let record = await VendorOnboarding.findOne({ user: req.user.userId });
    if (!record) record = await deriveFromUser(req.user.userId);
    if (!record) return res.status(404).json({ message: "Account not found" });

    if (record.status === "suspended") {
      return res.status(403).json({
        message: "Your vendor account is suspended. Contact support.",
        code: "SUSPENDED",
      });
    }

    // Everything that goes onto the User document, collected then written
    // once — so a failure part-way doesn't leave a half-updated account
    const userPatch = {};

    switch (step) {
      // ── 2 · Basic ────────────────────────────────────────────────
      case 2: {
        const phone = clean(req.body.phone, 40);
        const country = clean(req.body.country, 60);

        if (phone) {
          if (phone.replace(/\D/g, "").length < 7) {
            return res.status(400).json({
              message: "That phone number looks too short.",
            });
          }
          userPatch.phone = phone;
        }
        if (["Ghana", "Nigeria"].includes(country)) {
          userPatch.country = country;
          // Currency follows country, the same way serializeUser derives it
          userPatch.currency = country === "Nigeria" ? "NGN" : "GHS";
        }
        break;
      }

      // ── 3 · Account type ─────────────────────────────────────────
      case 3: {
        const type = clean(req.body.accountType, 20);
        if (!["vendor", "guest"].includes(type)) {
          return res.status(400).json({ message: "Choose vendor or guest" });
        }

        record.chosenType = type;

        // Never demote an admin. isAdminEmail in authController would
        // restore it on next login anyway, but flipping it here would
        // lock them out of the admin panel until then.
        const current = await User.findById(req.user.userId)
          .select("role")
          .lean();
        if (current?.role !== "admin") {
          userPatch.role = type === "guest" ? "guest" : "vendor";
        }

        if (type === "guest") {
          record.status = "complete";
          record.step = 7;
          record.completedAt = new Date();
          await record.save();
          await User.updateOne({ _id: req.user.userId }, { $set: userPatch });

          return res.status(200).json({
            done: true,
            message: "You're all set. Browse, shop and book as a guest.",
          });
        }
        break;
      }

      // ── 4 · Business ─────────────────────────────────────────────
      case 4: {
        const name = clean(req.body.name, 120);

        if (name !== undefined) {
          if (name.length < 2) {
            return res
              .status(400)
              .json({ message: "Business name is too short" });
          }
          userPatch.storeName = name;

          // Generate the slug once. Changing it later would break every
          // link anyone has shared to their store.
          const existing = await User.findById(req.user.userId)
            .select("storeSlug")
            .lean();
          if (!existing?.storeSlug) {
            userPatch.storeSlug = await makeStoreSlug(name, req.user.userId);
          }
        }

        const category = clean(req.body.category, 60);
        if (category) userPatch.storeCategory = category;

        const description = clean(req.body.description, 1000);
        if (description !== undefined) userPatch.storeDescription = description;

        const address = clean(req.body.address, 300);
        if (address !== undefined) userPatch.storeAddress = address;

        const website = clean(req.body.website, 200);
        if (website !== undefined) userPatch.storeWebsite = website;

        // Mapped, because the schema enum won't accept a friendly label
        // and updateOne wouldn't tell us it was rejected
        if (req.body.type) {
          userPatch.businessType = toBusinessType(req.body.type);
        }
        break;
      }

      // ── 5 · Services ─────────────────────────────────────────────
      case 5: {
        const allowed = ["ecommerce", "stays", "food", "marketplace"];
        const picked = (req.body.services ?? []).filter((s) =>
          allowed.includes(s),
        );
        if (picked.length === 0) {
          return res.status(400).json({
            message: "Choose at least one thing you'll be selling.",
          });
        }
        record.services = picked;
        userPatch.vendorServices = picked;
        break;
      }

      // ── 6 · Commission ───────────────────────────────────────────
      case 6: {
        if (req.body.acknowledged !== true) {
          return res.status(400).json({
            message: "Please confirm you understand the 5% commission.",
          });
        }
        record.acknowledgedCommission = true;
        record.acknowledgedAt = new Date();
        record.acknowledgedRate = COMMISSION_RATE;
        record.wantsSubscription = req.body.wantsSubscription === true;

        userPatch.commissionAcknowledgedAt = new Date();
        break;
      }

      default:
        break;
    }

    if (Object.keys(userPatch).length > 0) {
      await User.updateOne(
        { _id: req.user.userId },
        { $set: userPatch },
        { runValidators: true }, // catches an enum mistake here, not later
      );
    }

    record.step = Math.max(record.step ?? 2, step);
    if (record.status === "not_started") record.status = "in_progress";
    await record.save();

    const user = await User.findById(req.user.userId)
      .select("role storeName storeCategory")
      .lean();
    const missing = computeMissing(user, record);

    res.status(200).json({
      onboarding: {
        status: record.status,
        step: record.step,
        chosenType: record.chosenType,
        services: record.services ?? [],
        acknowledgedCommission: record.acknowledgedCommission,
        wantsSubscription: record.wantsSubscription,
      },
      missing,
      canComplete: missing.length === 0,
    });
  } catch (err) {
    // A duplicate slug is the one error worth explaining rather than
    // showing as a generic failure
    if (err?.code === 11000 && err?.keyPattern?.storeSlug) {
      return res.status(409).json({
        message: "That store name is taken. Try a slightly different one.",
        code: "SLUG_TAKEN",
      });
    }
    console.error("[saveStep]", err);
    res.status(500).json({ message: "Couldn't save that step" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// POST /onboarding/complete
//
// Approves immediately. There are no documents to review, so a waiting
// screen would be theatre — and a vendor signing up on Friday would lose
// the weekend.
// ═══════════════════════════════════════════════════════════════════════
export const completeOnboarding = async (req, res) => {
  try {
    const record = await VendorOnboarding.findOne({ user: req.user.userId });
    if (!record)
      return res.status(404).json({ message: "Start onboarding first" });

    if (record.status === "complete") {
      return res.status(200).json({ message: "You're already set up." });
    }
    if (record.status === "suspended") {
      return res.status(403).json({
        message: "Your vendor account is suspended. Contact support.",
      });
    }

    const user = await User.findById(req.user.userId)
      .select("role storeName storeSlug storeCategory")
      .lean();

    const missing = computeMissing(user, record);
    if (missing.length > 0) {
      return res.status(400).json({
        message: "A few things are still missing.",
        missing,
        code: "INCOMPLETE",
      });
    }

    record.status = "complete";
    record.step = 7;
    record.completedAt = new Date();
    await record.save();

    // Belt and braces: role should already be vendor from step 3, and the
    // slug from step 4. Setting them again costs nothing and covers the
    // case where someone reached here through a resumed session.
    const patch = { vendorSince: new Date() };
    if (user.role !== "admin" && user.role !== "vendor") patch.role = "vendor";
    if (!user.storeSlug) {
      patch.storeSlug = await makeStoreSlug(user.storeName, req.user.userId);
    }

    await User.updateOne({ _id: req.user.userId }, { $set: patch });

    res.status(200).json({
      message: "You're set up. Start listing whenever you're ready.",
      storeSlug: user.storeSlug ?? patch.storeSlug,
      nextStep: record.wantsSubscription ? "subscription" : "listing",
    });

    notify({
      userId: req.user.userId,
      type: "ad_approved",
      title: "Welcome to SmileBaba",
      message:
        `${user.storeName} is live. Post your first listing and start selling. ` +
        "We take 5% only when you make a sale.",
      actionUrl: "/sell",
      actionLabel: "Post a listing",
      dedupeKey: `onboarding-${record._id}-complete`,
    }).catch(() => {});
  } catch (err) {
    console.error("[completeOnboarding]", err);
    res.status(500).json({ message: "Couldn't finish setting you up" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /onboarding/vendors  (admin)
// ═══════════════════════════════════════════════════════════════════════
export const getVendorList = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const { status, grandfathered, page = 1, limit = 30 } = req.query;
    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (grandfathered === "true") filter.grandfathered = true;

    const [total, items] = await Promise.all([
      VendorOnboarding.countDocuments(filter),
      VendorOnboarding.find(filter)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate(
          "user",
          "username email phone country storeName storeSlug storeCategory createdAt",
        )
        .lean(),
    ]);

    res.status(200).json({
      items,
      meta: { total, page: Number(page), limit: Number(limit) },
    });
  } catch (err) {
    console.error("[getVendorList]", err);
    res.status(500).json({ message: "Couldn't load vendors" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// PATCH /onboarding/:id/suspend  (admin)
//
// The counterweight to instant approval: nobody is checked on the way
// in, so removing a bad actor has to be quick.
// ═══════════════════════════════════════════════════════════════════════
export const suspendVendor = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const { reason, reinstate } = req.body;
    const record = await VendorOnboarding.findById(req.params.id);
    if (!record) return res.status(404).json({ message: "Not found" });

    if (reinstate) {
      record.status = "complete";
      record.suspendedAt = undefined;
      record.suspendReason = undefined;
      await record.save();

      await User.updateOne({ _id: record.user }, { $set: { isActive: true } });

      // Listings stay hidden. An admin should look at what caused the
      // suspension before putting them back.
      return res.status(200).json({
        message:
          "Reinstated. Their listings are still hidden until you unhide them.",
      });
    }

    if (!reason) {
      return res
        .status(400)
        .json({ message: "Give a reason for the suspension" });
    }

    record.status = "suspended";
    record.suspendedAt = new Date();
    record.suspendReason = clean(reason, 500);
    record.suspendedBy = req.user.userId;
    await record.save();

    // isActive already exists on User and defaults true
    await User.updateOne({ _id: record.user }, { $set: { isActive: false } });
    await Ad.updateMany(
      { postedBy: record.user },
      { $set: { isActive: false } },
    );

    res.status(200).json({ message: "Vendor suspended" });

    notify({
      userId: record.user,
      type: "ad_rejected",
      title: "Your vendor account is suspended",
      message: `${record.suspendReason} Contact support if you think this is wrong.`,
      actionUrl: "/contact",
      actionLabel: "Contact support",
      dedupeKey: `onboarding-${record._id}-suspended`,
    }).catch(() => {});
  } catch (err) {
    console.error("[suspendVendor]", err);
    res.status(500).json({ message: "Couldn't update that vendor" });
  }
};

// ─── internal ────────────────────────────────────────────────────────

/** Reads from both documents, because the data lives in both. */
function computeMissing(user, record) {
  const gaps = [];
  if (record.chosenType !== "vendor") gaps.push("Account type");
  if (!user?.storeName) gaps.push("Business name");
  if (!user?.storeCategory) gaps.push("Business category");
  if (!record.services?.length) gaps.push("At least one service");
  if (!record.acknowledgedCommission) gaps.push("Confirm the 5% commission");
  return gaps;
}
