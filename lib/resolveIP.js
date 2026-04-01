// lib/resolveIP.js
// Extracts the real visitor IP from a request that has passed through
// Cloudflare → Render (or any reverse proxy chain).
//
// Header priority:
//   1. CF-Connecting-IP  — set by Cloudflare, always the real visitor IP
//   2. X-Real-IP         — set by some proxies
//   3. X-Forwarded-For   — leftmost is the original client when trust proxy is correct
//                          but behind Cloudflare the FIRST entry is the real visitor
//   4. req.socket.remoteAddress — last resort (will be proxy IP on Render)
//
// Why NOT just req.ip:
//   app.set("trust proxy", 1) makes req.ip the leftmost x-forwarded-for entry.
//   Behind Cloudflare that IS the real user IP. But CF-Connecting-IP is more
//   reliable because Cloudflare always sets it and strips user attempts to spoof it.

export function resolveClientIP(req) {
  // Cloudflare always sets this — most reliable
  const cf = req.headers["cf-connecting-ip"];
  if (cf && isReal(cf)) return cf.trim();

  // X-Real-IP set by nginx or other proxies
  const xri = req.headers["x-real-ip"];
  if (xri && isReal(xri)) return xri.trim();

  // X-Forwarded-For: client, proxy1, proxy2
  // Behind Cloudflare the leftmost is the real visitor
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first && isReal(first)) return first;
  }

  // Fallback — likely a proxy IP on Render but better than nothing
  return req.socket?.remoteAddress ?? "";
}

// Filter out private / loopback / link-local ranges
function isReal(ip) {
  if (!ip) return false;
  if (ip === "::1" || ip === "127.0.0.1") return false;
  // Private IPv4 ranges
  if (/^10\./.test(ip)) return false;
  if (/^192\.168\./.test(ip)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return false;
  // Cloudflare IP ranges are public — we DO want those when CF-Connecting-IP
  // is missing and xff only has a CF range (means it's an internal CF request)
  return true;
}
