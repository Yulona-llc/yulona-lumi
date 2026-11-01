import type { Logger } from "@yulona/shared";

export interface HitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}
export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<HitResult>;
  close(): void;
}

/** Sliding-window log in memory (single instance). */
export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, number[]>();
  private timer: ReturnType<typeof setInterval>;
  constructor(private readonly maxKeys = 100_000) {
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
  }
  async hit(key: string, limit: number, windowMs: number): Promise<HitResult> {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => t > now - windowMs);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((arr[0]! + windowMs - now) / 1000) };
    }
    arr.push(now);
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) this.sweep(true);
    this.hits.set(key, arr);
    return { allowed: true, remaining: limit - arr.length, retryAfterSec: 0 };
  }
  private sweep(force = false) {
    const cutoff = Date.now() - 3_600_000;
    for (const [k, v] of this.hits) {
      if ((v[v.length - 1] ?? 0) < cutoff) this.hits.delete(k);
    }
    if (force && this.hits.size >= this.maxKeys) this.hits.clear();
  }
  close() {
    clearInterval(this.timer);
  }
}

// Atomic sliding-window log in a sorted set. KEYS[1]=key ARGV: now, windowMs, limit, member
const LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, ARGV[1] - ARGV[2])
local n = redis.call('ZCARD', KEYS[1])
if n >= tonumber(ARGV[3]) then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return {0, n, oldest[2] or ARGV[1]}
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return {1, n + 1, ARGV[1]}`;

/** Redis-backed limiter (Bun's built-in client); falls back to memory if Redis errors. */
export class RedisRateLimiter implements RateLimiter {
  private client: Bun.RedisClient;
  private fallback = new MemoryRateLimiter();
  constructor(url: string, private readonly log?: Logger) {
    this.client = new Bun.RedisClient(url, { connectionTimeout: 2000, autoReconnect: true, maxRetries: 3 });
  }
  async hit(key: string, limit: number, windowMs: number): Promise<HitResult> {
    const now = Date.now();
    try {
      const res = (await this.client.send("EVAL", [LUA, "1", `rl:${key}`, String(now), String(windowMs), String(limit), `${now}-${Math.random()}`])) as [number, number, string];
      const allowed = Number(res[0]) === 1;
      return {
        allowed,
        remaining: Math.max(0, limit - Number(res[1])),
        retryAfterSec: allowed ? 0 : Math.ceil((Number(res[2]) + windowMs - now) / 1000),
      };
    } catch (e) {
      this.log?.warn("rate limiter redis error, using memory fallback", { err: (e as Error).message });
      return this.fallback.hit(key, limit, windowMs);
    }
  }
  async ping(): Promise<boolean> {
    try {
      await this.client.send("PING", []);
      return true;
    } catch {
      return false;
    }
  }
  close() {
    this.fallback.close();
    try {
      this.client.close();
    } catch {}
  }
}
