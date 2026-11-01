import type { Logger } from "@yulona/shared";
import type { Db } from "@yulona/db";
import type { Providers } from "@yulona/providers";
import type { Config } from "./config";
import type { RateLimiter } from "./ratelimit";

export interface Deps {
  cfg: Config;
  db: Db;
  limiter: RateLimiter;
  log: Logger;
  /** email provider for invitation resend (tests inject a mock) */
  providers?: Providers;
  /** tests point the provider "test" call at a local server */
  fetchImpl?: typeof fetch;
  dnsResolver?: (h: string) => Promise<string[]>;
}
