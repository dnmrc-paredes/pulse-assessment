// Fixed-window rate limiting. Server-only.
//
// SCOPE NOTE: this state lives in the server instance's memory. On Vercel each
// lambda has its own heap, so the effective limit is per-instance rather than
// global — it stops a single noisy client from hammering one instance, but a
// distributed flood can still fan out across instances. A global limit would
// need shared state (Redis/Upstash) or a Postgres counter; at this app's scale
// the in-memory window is the right trade, and the per-endpoint limits below
// are set with that in mind.

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

// Hard cap on tracked keys. Without this the limiter is itself an unbounded
// memory growth vector, since keys are derived from attacker-controlled input.
const MAX_BUCKETS = 10_000;

// How many inserts between sweeps of expired buckets.
const SWEEP_EVERY = 256;
let insertsSinceSweep = 0;

function sweep(now: number) {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfter: number };

// Consume one unit from `key`'s budget. Returns ok:false once `limit` requests
// have been made inside the `windowMs` window.
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();

  if (++insertsSinceSweep >= SWEEP_EVERY) {
    insertsSinceSweep = 0;
    sweep(now);
  }
  // Still oversized after a sweep (all keys live): drop the oldest insertion so
  // the map cannot grow without limit under a flood of distinct keys.
  if (buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next();
    if (!oldest.done) buckets.delete(oldest.value);
  }

  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true };
  }

  if (existing.count >= limit) {
    return { ok: false, retryAfter: Math.ceil((existing.resetAt - now) / 1000) };
  }

  existing.count += 1;
  return { ok: true };
}

// Best-effort client address for keying. Behind Vercel/CDNs x-forwarded-for is
// the first hop we can trust; falls back to a constant when absent.
export function clientKey(request: Request, scope: string): string {
  const fwd = request.headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "?";
  return `${scope}:${ip}`;
}
