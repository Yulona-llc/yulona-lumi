import type { Db } from "@yulona/db";
import type { Providers } from "@yulona/providers";
import type { Config } from "../config";
import type { RateLimiter } from "../ratelimit";

export interface IntegrationsDeps {
  cfg: Config;
  db: Db;
  limiter: RateLimiter;
  providers: Providers;
}

export const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());
