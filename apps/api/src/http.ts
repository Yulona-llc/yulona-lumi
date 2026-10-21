import type { Context } from "hono";
import type { z } from "zod";
import { AppError, Errors } from "./errors";

/** Strictly parse a JSON body with a Zod schema (use `z.strictObject`). */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const ct = c.req.header("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(ct)) {
    throw new AppError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError(400, "invalid_json", "Malformed JSON body");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    // path + message only; never echo submitted values (could be passwords)
    throw Errors.validation(r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  return r.data;
}
