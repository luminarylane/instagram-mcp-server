/**
 * Token-bucket rate limiter for Instagram Graph API.
 *
 * Instagram Graph API rate limits are per **Business Account**, not per app.
 * This limiter keys buckets by the caller's `tenantKey` (the IG Business
 * Account id) so that one dashboard user posting aggressively cannot
 * exhaust another user's quota.
 *
 * Each tenant gets an independent pair of buckets:
 *   - globalBucket:  200 tokens / 1 hour  (all API calls)
 *   - publishBucket:  25 tokens / 24 hours (photo / carousel / reel only)
 *
 * When `tenantKey` is undefined (single-tenant / env-based usage), all calls
 * share a single default bucket pair under the sentinel key "__default__".
 *
 * Stale tenant entries are evicted after 4h of inactivity on every call to
 * keep memory bounded for long-running multi-tenant servers.
 *
 * Also provides:
 *   - waitForRateLimit(): pre-flight check with optional wait
 *   - withRetry(): exponential backoff on server-side 429s
 */

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WAIT_MS = 60_000;
const MAX_429_RETRIES = 3;
const TENANT_TTL_MS = 4 * 60 * 60 * 1000; // 4h matches client cache TTL

export class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(config: { maxTokens: number; refillRate: number }) {
    this.maxTokens = config.maxTokens;
    this.refillRate = config.refillRate;
    this.tokens = config.maxTokens;
    this.lastRefill = Date.now();
  }

  tryConsume(cost = 1): boolean {
    this.refill();
    if (this.tokens >= cost) {
      this.tokens -= cost;
      return true;
    }
    return false;
  }

  msUntilAvailable(cost = 1): number {
    this.refill();
    if (this.tokens >= cost) return 0;
    const deficit = cost - this.tokens;
    return Math.ceil(deficit / this.refillRate);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = elapsed * this.refillRate;
    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }
}

// --- Per-tenant bucket storage ---

interface TenantBuckets {
  global: TokenBucket;
  publish: TokenBucket;
  lastAccessed: number;
}

const tenantBuckets = new Map<string, TenantBuckets>();
const DEFAULT_TENANT_KEY = "__default__";

function newBucketPair(): TenantBuckets {
  return {
    global: new TokenBucket({
      maxTokens: 200,
      refillRate: 200 / ONE_HOUR_MS,
    }),
    publish: new TokenBucket({
      maxTokens: 25,
      refillRate: 25 / ONE_DAY_MS,
    }),
    lastAccessed: Date.now(),
  };
}

/**
 * Get (or lazily create) the bucket pair for a tenant. Evicts stale entries
 * on every call so long-running multi-tenant servers don't leak memory.
 */
function getBuckets(tenantKey: string | undefined): TenantBuckets {
  const key = tenantKey || DEFAULT_TENANT_KEY;
  const now = Date.now();

  // Evict stale entries (except __default__ which is always kept)
  for (const [k, v] of tenantBuckets) {
    if (k !== DEFAULT_TENANT_KEY && now - v.lastAccessed > TENANT_TTL_MS) {
      tenantBuckets.delete(k);
    }
  }

  let entry = tenantBuckets.get(key);
  if (!entry) {
    entry = newBucketPair();
    tenantBuckets.set(key, entry);
  } else {
    entry.lastAccessed = now;
  }
  return entry;
}

/**
 * Test-only: wipe all tenant buckets. Used by unit tests to isolate cases.
 */
export function __resetRateLimiter(): void {
  tenantBuckets.clear();
}

// --- Publish tool detection ---

export const PUBLISH_TOOL_NAMES = new Set([
  "ig_publish_photo",
  "ig_publish_carousel",
  "ig_publish_reel",
]);

/**
 * Check rate limits and consume tokens.
 * Peek-then-consume: check all relevant buckets before consuming any.
 *
 * @param toolName    Tool being invoked (used to detect publish cost)
 * @param tenantKey   Per-tenant key (typically the IG Business Account id).
 *                    If omitted, uses a shared default bucket — fine for
 *                    single-tenant / env-based usage.
 * @param overrideCost Cost to consume (default 1)
 */
export function checkRateLimit(
  toolName?: string,
  tenantKey?: string,
  overrideCost?: number,
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  const { global, publish } = getBuckets(tenantKey);
  const isPublish = toolName ? PUBLISH_TOOL_NAMES.has(toolName) : false;
  const cost = overrideCost ?? 1;

  // Peek global bucket
  const globalWait = global.msUntilAvailable(cost);
  if (globalWait > 0) return { allowed: false, retryAfterMs: globalWait };

  if (isPublish) {
    const publishWait = publish.msUntilAvailable(cost);
    if (publishWait > 0) return { allowed: false, retryAfterMs: publishWait };

    // Consume both
    global.tryConsume(cost);
    publish.tryConsume(cost);
    return { allowed: true };
  }

  // Read path: consume global only
  if (!global.tryConsume(cost)) {
    return {
      allowed: false,
      retryAfterMs: global.msUntilAvailable(cost),
    };
  }
  return { allowed: true };
}

/**
 * Pre-flight rate limit check. Waits up to 60s if bucket is near-empty.
 * Returns DEFER guidance if wait would exceed 60s.
 */
export async function waitForRateLimit(
  toolName?: string,
  tenantKey?: string,
  overrideCost?: number,
): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
  const check = checkRateLimit(toolName, tenantKey, overrideCost);
  if (check.allowed) return check;

  if (check.retryAfterMs <= MAX_WAIT_MS) {
    await sleep(check.retryAfterMs);
    return checkRateLimit(toolName, tenantKey, overrideCost);
  }

  return check;
}

/**
 * Retry a function with exponential backoff on HTTP 429 errors.
 * Also parses Retry-After header when available.
 */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e: unknown) {
      const is429 = isRateLimitError(e);
      if (!is429 || attempt === MAX_429_RETRIES) throw e;

      // Honor Retry-After header if present
      const retryAfter = extractRetryAfter(e);
      const backoffMs = retryAfter ?? 2000 * Math.pow(2, attempt);

      console.error(
        `[rate-limit] Instagram 429 — backing off ${backoffMs / 1000}s (attempt ${attempt + 1}/${MAX_429_RETRIES})...`,
      );
      await sleep(backoffMs);
    }
  }
  throw new Error("Unreachable");
}

function isRateLimitError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const obj = e as Record<string, unknown>;

  // Graph API error format: { error: { code: 4, ... } } or HTTP 429
  if (obj.status === 429) return true;
  if (typeof obj.code === "number" && (obj.code === 4 || obj.code === 32))
    return true;

  // Nested error object
  if (typeof obj.error === "object" && obj.error !== null) {
    const inner = obj.error as Record<string, unknown>;
    if (inner.code === 4 || inner.code === 32) return true;
  }

  if (e instanceof Error) {
    const msg = e.message.toLowerCase();
    if (msg.includes("429") || msg.includes("rate limit")) return true;
  }

  return false;
}

function extractRetryAfter(e: unknown): number | null {
  if (typeof e !== "object" || e === null) return null;
  const obj = e as Record<string, unknown>;

  // Check for retryAfter in error metadata
  if (typeof obj.retryAfter === "number") return obj.retryAfter * 1000;
  if (typeof obj.retryAfterMs === "number") return obj.retryAfterMs;

  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
