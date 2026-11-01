import { apiBase } from "../config";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public details?: unknown,
    public retryAfter?: number,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...a) => fetch(...a);
/** Used by tests. */
export function setFetchImpl(f: FetchLike) {
  fetchImpl = f;
}

// The access token lives in module memory only. It is never written to storage; a reload restores the session from the
// httpOnly refresh cookie (POST /auth/refresh).
let accessToken: string | null = null;
let refreshing: Promise<SessionPayload | null> | null = null;
let onSessionLost: (() => void) | null = null;
let onRestricted: ((reason: string) => void) | null = null;
export const getAccessToken = () => accessToken;
export const setAccessToken = (t: string | null) => { accessToken = t; };
export function setSessionLostHandler(fn: (() => void) | null) { onSessionLost = fn; }
export function setRestrictedHandler(fn: ((reason: string) => void) | null) { onRestricted = fn; }

export interface Opts {
  method?: string;
  body?: unknown;
  auth?: boolean;
  /** Cookie endpoints (refresh/logout) need the X-Admin-Request header. */
  cookie?: boolean;
  retry?: boolean;
}

async function raw(path: string, o: Opts, accept = "application/json"): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept };
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  if (o.auth !== false && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (o.cookie) headers["X-Admin-Request"] = "1";
  let res: Response;
  try {
    res = await fetchImpl(`${apiBase()}${path}`, {
      method: o.method ?? "GET",
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      credentials: "include",
    });
  } catch {
    throw new ApiError(0, "network_error", "Cannot reach the admin API. Check your connection.");
  }
  if (res.status === 401 && o.auth !== false && o.retry !== false && !o.cookie) {
    if (await refreshOnce()) return raw(path, { ...o, retry: false }, accept);
    accessToken = null;
    onSessionLost?.();
  }
  if (!res.ok) throw await toError(res);
  return res;
}

async function toError(res: Response): Promise<ApiError> {
  let e: { error?: { code?: string; message?: string; requestId?: string; details?: unknown } } = {};
  try { e = await res.json(); } catch { /* non-JSON error body */ }
  const retryAfter = Number(res.headers.get("Retry-After")) || undefined;
  const err = new ApiError(res.status, e.error?.code ?? "http_error", e.error?.message ?? `Request failed (${res.status})`, e.error?.requestId, e.error?.details, retryAfter);
  if (res.status === 403 && err.code === "session_restricted") onRestricted?.((err.details as { reason?: string } | undefined)?.reason ?? "password_change");
  return err;
}

export async function request<T = void>(path: string, o: Opts = {}): Promise<T> {
  const res = await raw(path, o);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Downloads a CSV/JSON export through the authenticated client and saves it. */
export async function download(path: string, fallbackName: string): Promise<void> {
  const res = await raw(path, {}, "*/*");
  const cd = res.headers.get("Content-Disposition") ?? "";
  const name = /filename="?([^";]+)"?/.exec(cd)?.[1] ?? fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface SessionPayload { accessToken: string; expiresIn: number; admin: import("./types").Me }

async function refreshOnce(): Promise<boolean> {
  return (await refreshSession()) !== null;
}

/** Single-flight refresh with the httpOnly cookie. Resolves null when there is no valid session. */
export function refreshSession(): Promise<SessionPayload | null> {
  refreshing ??= request<SessionPayload>("/auth/refresh", { method: "POST", cookie: true, auth: false, retry: false })
    .then((s) => { accessToken = s.accessToken; return s; })
    .catch(() => { accessToken = null; return null; })
    .finally(() => { refreshing = null; });
  return refreshing;
}
