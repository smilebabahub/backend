// controllers/reportController.js
//
// Listing reports.
//
//   submitReport    — public; a guest can report a scam without signing up
//   getReports      — admin queue
//   getAdReports    — every report against one listing
//   resolveReport   — admin decision, with the action carried out
//
// The part that does the real work is the auto-hide: once enough distinct
// people flag the same listing, it comes down without waiting for an
// admin. A scam that runs overnight costs more than a real listing hidden
// for an hour by mistake, and the vendor gets told and can appeal.

import Ad from "../models/adModel.js";
import User from "../models/user.js";
import Report, {
  AUTO_HIDE_THRESHOLD,
  REASON_WEIGHT,
} from "../models/reportModel.js";
import { notify } from "../lib/notify.js";

const clean = (v, max = 1000) =>
  typeof v === "string" ? v.trim().slice(0, max) : undefined;

const VALID_REASONS = [
  "scam",
  "misleading",
  "prohibited",
  "duplicate",
  "sold",
  "offensive",
  "counterfeit",
  "other",
];

// ═══════════════════════════════════════════════════════════════════════
// POST /reports
//
// Public. Requiring a login to report a scam means scams stay up.
// ═══════════════════════════════════════════════════════════════════════
export const submitReport = async (req, res) => {
  try {
    const adId = clean(req.body.adId, 40);
    const reason = clean(req.body.reason, 40);
    const details = clean(req.body.details, 1000);
    const email = clean(req.body.reporterEmail, 200)?.toLowerCase();

    if (!reason || !VALID_REASONS.includes(reason)) {
      return res.status(400).json({ message: "Tell us what's wrong." });
    }
    if (!adId && !req.body.vendorId) {
      return res.status(400).json({
        message: "We need to know what you're reporting.",
      });
    }
    if (reason === "other" && (!details || details.length < 4)) {
      return res.status(400).json({
        message: "Tell us a little about what's wrong.",
      });
    }

    // ── Snapshot, because the listing may change or vanish ───────────
    let ad = null;
    let snapshot = {};

    if (adId) {
      ad = await Ad.findById(adId)
        .populate("postedBy", "username storeName")
        .lean();

      if (!ad) {
        // Already gone — nothing to do, but don't make the reporter
        // feel like they wasted their time
        return res.status(200).json({
          message: "That listing is no longer on SmileBaba.",
        });
      }

      snapshot = {
        title: ad.title,
        price: ad.price?.amount ?? ad.price,
        currency: ad.price?.currency,
        category: ad.category?.main,
        vendorName: ad.postedBy?.storeName ?? ad.postedBy?.username,
      };
    }

    const vendorId = req.body.vendorId ?? ad?.postedBy?._id;

    // A vendor reporting their own listing is either a mistake or an
    // attempt to game the count
    if (
      req.user?.userId &&
      vendorId &&
      String(vendorId) === String(req.user.userId)
    ) {
      return res.status(400).json({
        message: "You can't report your own listing.",
      });
    }

    // ── Create. The unique index stops a repeat report. ──────────────
    let report;
    try {
      report = await Report.create({
        ad: adId,
        vendor: vendorId,
        reporter: req.user?.userId,
        reporterEmail: email,
        reason,
        details,
        snapshot,
        ip: req.clientIp ?? req.ip,
      });
    } catch (err) {
      if (err.code === 11000) {
        // Already reported by this person. Say thanks rather than
        // explaining our indexes to them.
        return res.status(200).json({
          message:
            "Thanks — you've already reported this. We're looking at it.",
        });
      }
      throw err;
    }

    res.status(201).json({
      message: "Report received",
      reference: report.reference,
    });

    // ── Everything below is non-blocking ─────────────────────────────
    if (adId) {
      evaluateAutoHide({ adId, report, ad }).catch((e) =>
        console.error("[report] auto-hide:", e.message),
      );
    }

    notifyAdmins({ report, snapshot }).catch(() => {});
  } catch (err) {
    console.error("[submitReport]", err);
    res.status(500).json({ message: "Couldn't send that report." });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /reports  (admin)
// ═══════════════════════════════════════════════════════════════════════
export const getReports = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const { status = "open", reason, page = 1, limit = 30 } = req.query;

    const filter = {};
    if (status && status !== "all") filter.status = status;
    if (reason) filter.reason = reason;

    const skip = (Number(page) - 1) * Number(limit);

    const [total, reports, counts] = await Promise.all([
      Report.countDocuments(filter),
      Report.find(filter)
        .sort({ createdAt: 1 }) // oldest first — a queue, not a feed
        .skip(skip)
        .limit(Number(limit))
        .populate("reporter", "username email")
        .populate("vendor", "username storeName email")
        .populate("ad", "title slug isActive isPaused coverImage images")
        .lean(),
      Report.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);

    res.status(200).json({
      reports: reports.map(serialise),
      counts: counts.reduce((acc, c) => ({ ...acc, [c._id]: c.count }), {
        open: 0,
        reviewing: 0,
        actioned: 0,
        dismissed: 0,
      }),
      meta: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch (err) {
    console.error("[getReports]", err);
    res.status(500).json({ message: "Couldn't load reports" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// GET /reports/ad/:adId  (admin)
//
// Three separate people saying "scam" is a different signal from three
// people saying three different things.
// ═══════════════════════════════════════════════════════════════════════
export const getAdReports = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const reports = await Report.find({ ad: req.params.adId })
      .sort({ createdAt: -1 })
      .populate("reporter", "username email")
      .lean();

    const byReason = reports.reduce((acc, r) => {
      acc[r.reason] = (acc[r.reason] ?? 0) + 1;
      return acc;
    }, {});

    res.status(200).json({
      reports: reports.map(serialise),
      total: reports.length,
      byReason,
      distinctReporters: new Set(reports.map((r) => String(r.reporter ?? r.ip)))
        .size,
    });
  } catch (err) {
    console.error("[getAdReports]", err);
    res.status(500).json({ message: "Couldn't load reports" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// PATCH /reports/:id/resolve  (admin)
//
// Carries out the decision as well as recording it — an admin marking a
// report "ad_removed" should not then have to go and remove the ad.
// ═══════════════════════════════════════════════════════════════════════
export const resolveReport = async (req, res) => {
  try {
    if (req.user.role !== "admin") {
      return res.status(403).json({ message: "Admin access required" });
    }

    const { resolution, note } = req.body;
    const valid = [
      "ad_removed",
      "ad_edited",
      "vendor_warned",
      "vendor_suspended",
      "no_action",
      "duplicate_report",
    ];
    if (!valid.includes(resolution)) {
      return res.status(400).json({ message: "Invalid resolution" });
    }

    const report = await Report.findById(req.params.id);
    if (!report) return res.status(404).json({ message: "Report not found" });

    report.status = resolution === "no_action" ? "dismissed" : "actioned";
    report.resolution = resolution;
    report.resolutionNote = clean(note, 500);
    report.reviewedBy = req.user.userId;
    report.reviewedAt = new Date();
    await report.save();

    // ── Carry it out ─────────────────────────────────────────────────
    if (resolution === "ad_removed" && report.ad) {
      await Ad.updateOne(
        { _id: report.ad },
        {
          $set: {
            isActive: false,
            "moderation.status": "rejected",
            "moderation.rejectReason":
              report.resolutionNote ?? "Reported by users",
            "moderation.reviewedBy": req.user.userId,
            "moderation.reviewedAt": new Date(),
          },
        },
      );

      notify({
        userId: report.vendor,
        type: "ad_rejected",
        title: "Listing removed",
        message:
          `"${report.snapshot?.title ?? "Your listing"}" was removed after user reports. ` +
          (report.resolutionNote ??
            "Contact support if you think this is wrong."),
        actionUrl: "/account/listings",
        actionLabel: "View listings",
        dedupeKey: `report-${report._id}-removed`,
      }).catch(() => {});
    }

    if (resolution === "vendor_suspended" && report.vendor) {
      await User.updateOne(
        { _id: report.vendor },
        { $set: { isSuspended: true, suspendedAt: new Date() } },
      );
      // Their listings go with them
      await Ad.updateMany(
        { postedBy: report.vendor },
        { $set: { isActive: false } },
      );
    }

    if (resolution === "vendor_warned" && report.vendor) {
      notify({
        userId: report.vendor,
        type: "ad_flagged",
        title: "Warning about your listing",
        message:
          report.resolutionNote ??
          "A listing of yours was reported. Please review our guidelines.",
        actionUrl: "/account/listings",
        actionLabel: "Review listings",
        dedupeKey: `report-${report._id}-warned`,
      }).catch(() => {});
    }

    // A listing cleared by an admin comes back out of auto-hide
    if (resolution === "no_action" && report.ad) {
      await Ad.updateOne(
        { _id: report.ad, isPaused: true },
        { $set: { isPaused: false, isActive: true } },
      );

      // And its other open reports are settled too, so the queue doesn't
      // ask the same question again
      await Report.updateMany(
        { ad: report.ad, status: { $in: ["open", "reviewing"] } },
        {
          $set: {
            status: "dismissed",
            resolution: "duplicate_report",
            reviewedBy: req.user.userId,
            reviewedAt: new Date(),
          },
        },
      );
    }

    res
      .status(200)
      .json({ message: "Report resolved", report: serialise(report) });
  } catch (err) {
    console.error("[resolveReport]", err);
    res.status(500).json({ message: "Couldn't resolve that report" });
  }
};

// ═══════════════════════════════════════════════════════════════════════
// INTERNAL
// ═══════════════════════════════════════════════════════════════════════

/**
 * Hide a listing once enough distinct people have flagged it.
 *
 * Counts weighted reports from distinct reporters — the same person
 * reporting twice can't trip it, and fraud reasons count for more, so a
 * clear scam comes down at two rather than three.
 *
 * It pauses rather than deletes, so an admin can reverse it.
 */
async function evaluateAutoHide({ adId, report, ad }) {
  const reports = await Report.find({
    ad: adId,
    status: { $in: ["open", "reviewing"] },
  })
    .select("reason reporter ip")
    .lean();

  // Distinct people, by account where we have one and IP where we don't
  const seen = new Map();
  for (const r of reports) {
    const who = String(r.reporter ?? r.ip ?? Math.random());
    const weight = REASON_WEIGHT[r.reason] ?? 1;
    // Keep the heaviest reason per person
    seen.set(who, Math.max(seen.get(who) ?? 0, weight));
  }

  const score = [...seen.values()].reduce((a, b) => a + b, 0);
  if (score < AUTO_HIDE_THRESHOLD) return;

  const target = ad ?? (await Ad.findById(adId).lean());
  if (!target || target.isPaused || target.isActive === false) return;

  await Ad.updateOne(
    { _id: adId },
    { $set: { isPaused: true, "moderation.status": "flagged" } },
  );

  await Report.updateOne(
    { _id: report._id },
    { $set: { triggeredAutoHide: true } },
  );

  console.warn(
    `[report] auto-hid ad ${adId} — score ${score.toFixed(1)} from ${seen.size} reporters`,
  );

  // Tell the vendor. Being hidden without explanation is worse than
  // being hidden.
  notify({
    userId: target.postedBy,
    type: "ad_flagged",
    title: "Listing hidden pending review",
    message:
      `"${target.title}" has been hidden while we look into reports from other users. ` +
      "Our team will review it within 24 hours.",
    actionUrl: "/account/listings",
    actionLabel: "View listing",
    dedupeKey: `report-autohide-${adId}`,
  }).catch(() => {});
}

async function notifyAdmins({ report, snapshot }) {
  const admins = await User.find({ role: "admin" }).select("_id").lean();
  const urgent = ["scam", "counterfeit", "prohibited"].includes(report.reason);

  await Promise.allSettled(
    admins.map((a) =>
      notify({
        userId: a._id,
        type: "ad_flagged",
        title: urgent ? "Urgent report" : "New report",
        message:
          `${report.reason.replace(/_/g, " ")} — "${snapshot?.title ?? "a listing"}"` +
          (report.details ? `: ${report.details.slice(0, 90)}` : ""),
        actionUrl: "/admin/reports",
        actionLabel: "Review",
        dedupeKey: `report-${report._id}-admin-${a._id}`,
        push: urgent, // only interrupt for the serious ones
      }),
    ),
  );
}

function serialise(r) {
  const raw = r.toObject ? r.toObject() : r;
  return {
    _id: String(raw._id),
    reference:
      raw.reference ?? `RPT-${String(raw._id).slice(-6).toUpperCase()}`,
    reason: raw.reason,
    details: raw.details,
    status: raw.status,
    resolution: raw.resolution,
    resolutionNote: raw.resolutionNote,
    triggeredAutoHide: raw.triggeredAutoHide,
    snapshot: raw.snapshot,
    ad: raw.ad?._id
      ? {
          _id: String(raw.ad._id),
          title: raw.ad.title,
          slug: raw.ad.slug,
          isActive: raw.ad.isActive,
          isPaused: raw.ad.isPaused,
          image: raw.ad.coverImage ?? raw.ad.images?.[0]?.url ?? null,
        }
      : raw.ad
        ? { _id: String(raw.ad) }
        : null,
    vendor: raw.vendor?._id
      ? {
          _id: String(raw.vendor._id),
          name: raw.vendor.storeName ?? raw.vendor.username,
          email: raw.vendor.email,
        }
      : null,
    reporter: raw.reporter?._id
      ? { _id: String(raw.reporter._id), name: raw.reporter.username }
      : null,
    reviewedAt: raw.reviewedAt,
    createdAt: raw.createdAt,
  };
}
