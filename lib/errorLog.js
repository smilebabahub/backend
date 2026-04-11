// lib/errorLog.js
// In-process circular error log — keeps the last N errors in memory.
// Written to by any controller that catches an unexpected error.
// Exposed via GET /admin/system/errors for the admin system page.
//
// Why in-memory and not DB?
//   - Zero latency on every request — no async write blocking
//   - Errors visible even if DB itself is down
//   - Not persisted across restarts (that's fine — this is for live debugging)

const MAX_ENTRIES = 200;

const _log = [];

/**
 * Record an error. Call from any catch block:
 *   import { logError } from "../lib/errorLog.js";
 *   logError("myController", err, { userId, route: req.path });
 */
export function logError(source, err, context = {}) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    ts: new Date().toISOString(),
    source,
    message: err?.message ?? String(err),
    stack: err?.stack?.split("\n").slice(0, 5).join("\n") ?? null,
    context,
  };

  _log.unshift(entry); // newest first
  if (_log.length > MAX_ENTRIES) _log.pop(); // drop oldest

  // Also write to stdout so Render logs capture it
  console.error(`[${source}]`, entry.message);
}

/**
 * Get recent errors, optionally filtered by source.
 * @param {number} limit
 * @param {string} [source]
 */
export function getErrors(limit = 50, source = null) {
  const filtered = source ? _log.filter((e) => e.source === source) : _log;
  return filtered.slice(0, limit);
}

/**
 * Clear the log (admin action).
 */
export function clearErrors() {
  _log.length = 0;
}

/**
 * Count errors grouped by source in the last N minutes.
 */
export function getErrorSummary(minutes = 60) {
  const since = new Date(Date.now() - minutes * 60_000);
  const recent = _log.filter((e) => new Date(e.ts) >= since);
  const bySource = {};
  for (const e of recent) {
    bySource[e.source] = (bySource[e.source] ?? 0) + 1;
  }
  return { total: recent.length, bySource, since: since.toISOString() };
}
