import type { Context } from "hono";
import type { z } from "zod";
import { AppError, Errors } from "./errors";

/** Strictly parse a JSON body with a Zod schema (use `z.strictObject`). */
export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  const ct = c.req.header("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(ct)) throw new AppError(415, "unsupported_media_type", "Content-Type must be application/json");
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError(400, "invalid_json", "Malformed JSON body");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw Errors.validation(r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw Errors.validation(r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  return r.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function parseId(c: Context, name = "id"): string {
  const v = c.req.param(name) ?? "";
  if (!UUID.test(v)) throw Errors.notFound();
  return v;
}

export const isUniqueViolation = (e: unknown) => (e as { code?: string }).code === "23505";
export const isFkViolation = (e: unknown) => (e as { code?: string }).code === "23503";

export const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

/** CSV with formula-injection protection (cells starting with = + - @ are prefixed with a quote). */
export function toCsv(header: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

/**
 * `total` for a page produced with `count(*) OVER ()`: that column vanishes when the offset is past the last row,
 * so an empty page beyond offset 0 asks again for the first row.
 */
export async function pageTotal(rows: { total: string }[], offset: number, first: () => Promise<{ total: string }[]>): Promise<number> {
  if (rows[0]) return Number(rows[0].total);
  if (offset === 0) return 0;
  const f = await first();
  return f[0] ? Number(f[0].total) : 0;
}
