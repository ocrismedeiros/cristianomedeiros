// Fixed-window in-memory rate limiter keyed by an arbitrary string (the IP).
// Good enough for a single-process app; resets on restart.
function createRateLimiter({ max, windowMs }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }, 60 * 1000);
  sweep.unref();

  return {
    // Records a hit and returns true if the caller is still within the limit.
    hit(key) {
      const now = Date.now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return entry.count <= max;
    },
    retryAfterSec(key) {
      const entry = hits.get(key);
      return entry ? Math.max(1, Math.ceil((entry.resetAt - Date.now()) / 1000)) : 0;
    },
  };
}

module.exports = { createRateLimiter };
