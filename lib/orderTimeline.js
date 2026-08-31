// lib/orderTimeline.js
//
// The order's event trail. Every status change appends an entry, so the
// tracking screen shows what happened and when rather than just where the
// order currently sits.
//
// Each entry is append-only. A cancelled order still shows that it was
// confirmed and dispatched first — that history is what a buyer needs when
// something goes wrong, and what support needs to sort it out.
//
// models/orderModel.js — add:
//
//   timeline: [{
//     status:  { type: String, required: true },
//     label:   String,
//     note:    String,
//     actor:   { type: String, enum: ["buyer", "vendor", "system", "admin"] },
//     at:      { type: Date, default: Date.now },
//   }],

import Order from "../models/orderModel.js";

/** Buyer-facing copy for each event. Written for the person, not the log. */
const EVENT_COPY = {
  placed: {
    label: "Order placed",
    note: "Waiting for payment to be confirmed.",
  },
  paid: {
    label: "Payment confirmed",
    note: "We're holding your payment until you confirm delivery.",
  },
  confirmed: {
    label: "Vendor confirmed",
    note: "Your order is being prepared.",
  },
  dispatched: {
    label: "On the way",
    note: "The vendor has sent your order out.",
  },
  delivered: {
    label: "Delivered",
    note: "Confirm you've received it to release payment to the vendor.",
  },
  completed: {
    label: "Completed",
    note: "Delivery confirmed. The vendor has been paid.",
  },
  cancelled: {
    label: "Cancelled",
    note: "This order was cancelled.",
  },
  refund_requested: {
    label: "Refund requested",
    note: "The vendor has 48 hours to respond.",
  },
  refund_approved: {
    label: "Refund approved",
    note: "Your money is on its way back, usually within 3–5 business days.",
  },
  refund_rejected: {
    label: "Refund declined",
    note: "You can escalate this to SmileBaba support.",
  },
  disputed: {
    label: "Reported",
    note: "Support is reviewing. Your payment is frozen until this is resolved.",
  },
  refunded: {
    label: "Refunded",
    note: "This order was refunded in full.",
  },
};

/**
 * Append an event to an order's timeline.
 *
 * Safe to call twice — the same status from the same actor within a minute
 * is treated as a duplicate and skipped, so a webhook and a client verify
 * arriving together don't double up.
 *
 * @param {object} order  A mongoose Order document (not a lean object)
 * @param {string} event  Key from EVENT_COPY
 * @param {object} [opts]
 * @param {string} [opts.actor="system"]
 * @param {string} [opts.note]  Overrides the default copy
 */
export function addTimelineEntry(order, event, opts = {}) {
  if (!order) return;

  const copy = EVENT_COPY[event] ?? { label: event, note: undefined };
  const actor = opts.actor ?? "system";

  order.timeline = order.timeline ?? [];

  // Duplicate guard — same event, same actor, inside a minute
  const last = order.timeline[order.timeline.length - 1];
  if (
    last &&
    last.status === event &&
    last.actor === actor &&
    Date.now() - new Date(last.at).getTime() < 60_000
  ) {
    return;
  }

  order.timeline.push({
    status: event,
    label: copy.label,
    note: opts.note ?? copy.note,
    actor,
    at: new Date(),
  });
}

/**
 * The full journey for the tracking UI: every step a normal order passes
 * through, each marked done, current, or upcoming.
 *
 * Cancelled and refunded orders return only what actually happened —
 * showing "Delivered" as an upcoming step on a cancelled order would be
 * misleading.
 */
export function buildJourney(order) {
  const timeline = order.timeline ?? [];
  const done = new Map(timeline.map((t) => [t.status, t]));

  const terminal = ["cancelled", "refunded"].includes(order.status);
  if (terminal) {
    return timeline.map((t) => ({
      key: t.status,
      label: t.label,
      note: t.note,
      at: t.at,
      state: "done",
    }));
  }

  const steps = [
    "placed",
    "paid",
    "confirmed",
    "dispatched",
    "delivered",
    "completed",
  ];
  const lastDoneIdx = steps.reduce(
    (acc, key, i) => (done.has(key) ? i : acc),
    -1,
  );

  return steps.map((key, i) => {
    const entry = done.get(key);
    return {
      key,
      label: entry?.label ?? EVENT_COPY[key].label,
      note: entry?.note ?? EVENT_COPY[key].note,
      at: entry?.at ?? null,
      state:
        i <= lastDoneIdx
          ? "done"
          : i === lastDoneIdx + 1
            ? "current"
            : "upcoming",
    };
  });
}

/** Plain-language summary of where an order stands right now. */
export function statusSummary(order) {
  const map = {
    pending: "Waiting for payment",
    confirmed: "Being prepared",
    dispatched: "On the way",
    delivered: "Delivered — confirm to release payment",
    cancelled: "Cancelled",
    refunded: "Refunded",
  };
  if (order.escrowStatus === "disputed") return "Under review by support";
  if (order.escrowStatus === "released" && order.status === "delivered") {
    return "Completed";
  }
  return map[order.status] ?? order.status;
}

export { EVENT_COPY };

