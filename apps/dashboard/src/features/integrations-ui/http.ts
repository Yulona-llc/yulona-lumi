import { z } from "zod";
import { request as raw, getAccessToken, ApiError, type Opts } from "../../api/client";
import { apiBase } from "../../config";

/** Typed-by-assertion request helper for the admin-area features (channels, billing, integrations). */
export const req = <T,>(path: string, o: Opts<T> = {}) => raw<T>(path, { auth: true, ...o, schema: z.any() as z.ZodType<T> });
export const send = (method: string, body?: unknown) => ({ method, body });
export const qs = (o: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

/** Download an authenticated attachment (bearer token cannot ride a plain <a href>). */
export async function downloadAuthed(path: string, fallbackName: string, token: string | null = getAccessToken()) {
  const res = await fetch(`${apiBase()}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, credentials: "include" });
  if (!res.ok) {
    let msg = `Download failed (${res.status})`;
    try { msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* non-JSON */ }
    throw new ApiError(res.status, "download_failed", msg);
  }
  const cd = res.headers.get("Content-Disposition") ?? "";
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const copy = (t: string) => void navigator.clipboard?.writeText(t);
