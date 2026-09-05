// cron/accountDeletion.js
//
// Completes account deletions once their 30-day grace period has passed.
//
// Same shape as cron/subscriptionExpiry.js — export a start function,
// call it from server.js. Runs at 04:00 Accra time, after the payout
// cron at 02:00 and before the subscription check at 08:00, so the three
// don't contend for the same connection pool.
//
// The Africa/Accra timezone matters: Render runs on UTC, so without it
// "4am" drifts to whenever UTC happens to be.

import cron from "node-cron";
import { processDueDeletions } from "../controllers/supportController.js";

async function runDeletions() {
  console.log("[cron] Running account deletion sweep…");

  try {
    const completed = await processDueDeletions();
    if (completed > 0) {
      console.log(
        `[cron] ${completed} account${completed === 1 ? "" : "s"} deleted`,
      );
    }
  } catch (err) {
    // Never let a failed sweep take the process down — the requests stay
    // in "confirmed" and get picked up tomorrow.
    console.error("[cron] Account deletion sweep failed:", err.message);
  }
}

export function startAccountDeletionCron() {
  cron.schedule("0 4 * * *", runDeletions, {
    timezone: "Africa/Accra",
  });

  console.log("[cron] Account deletion sweep scheduled (daily 04:00 GMT)");
}

// Exported for manual runs and testing
export { runDeletions };

// ═══════════════════════════════════════════════════════════════════════
// server.js
//
// Add alongside startSubscriptionCron():
//
//     import { startAccountDeletionCron } from "./cron/accountDeletion.js";
//
//     startSubscriptionCron();
//     startAccountDeletionCron();   // ← add
//
//
// Your cron directory then holds:
//     cron/subscriptionExpiry.js   08:00 — expiry notices and downgrades
//     cron/adExpiryCron.js         (whenever it's set to)
//     cron/autoPayout.js           02:00 — vendor payouts
//     cron/accountDeletion.js      04:00 — this one
// ═══════════════════════════════════════════════════════════════════════
//
// To test without waiting for 4am, run the sweep directly:
//
//     node --input-type=module -e "
//       import('./cron/accountDeletion.js').then(m => m.runDeletions());
//     "
//
// Or temporarily change the expression to '*/2 * * * *' for every two
// minutes — just remember to change it back.
