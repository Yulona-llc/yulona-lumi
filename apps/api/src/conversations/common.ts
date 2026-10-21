import type { Context } from "hono";
import type { z } from "zod";
import type { Role } from "@yulona/shared";
import type { Db } from "@yulona/db";
import type { Config } from "../config";
import type { AppEnv } from "../context";
import { Errors } from "../errors";
import type { RateLimiter } from "../ratelimit";
import type { Realtime } from "../realtime/service";
import { decodeCursor } from "./dto";

export interface ConvDeps {
  cfg: Config;
  db: Db;
  limiter: RateLimiter;
  realtime: Realtime;
}

/** Parse query params with a strict schema (unknown params => 400). */
export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.req.query())) raw[k] = v;
  const r = schema.safeParse(raw);
  if (!r.success) throw Errors.validation(r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

export function cursorOf(raw: string | undefined) {
  if (raw === undefined) return null;
  const cur = decodeCursor(raw);
  if (!cur) throw Errors.validation([{ path: "cursor", message: "Invalid cursor" }]);
  return cur;
}

export function requireRoles(...roles: Role[]) {
  return async (c: Context<AppEnv>, next: () => Promise<void>) => {
    if (!roles.includes(c.get("auth").role)) throw Errors.forbidden("Insufficient role");
    await next();
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Path ids that are not UUIDs can never match: answer 404 rather than a Postgres cast error. */
export function idParam(c: Context, name = "id"): string {
  const v = c.req.param(name) ?? "";
  if (!UUID.test(v)) throw Errors.notFound();
  return v;
}
