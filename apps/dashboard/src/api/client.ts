import type { z } from "zod";
import { apiBase } from "../config";
import {
  errorEnvelopeSchema,
  impersonationSessionSchema,
  meSchema,
  sessionSchema,
  type ImpersonationSession,
  type LoginRequest,
  type Me,
  type RegisterRequest,
  type Session,
} from "./contract";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...a) => fetch(...a);
/** Used by mock mode and tests. */
export function setFetchImpl(f: FetchLike) {
  fetchImpl = f;
}

/** The same fetch the client uses (swapped in mock mode and tests), for calls that are not JSON (multipart upload, image bytes). */
export const rawFetch: FetchLike = (...a) => fetchImpl(...a);

// Access token lives in module memory only. Never persisted.
let accessToken: string | null = null;
let refreshing: Promise<Session | null> | null = null;
let onSessionLost: (() => void) | null = null;
export const getAccessToken = () => accessToken;
export function setSessionLostHandler(fn: (() => void) | null) {
  onSessionLost = fn;
}
export function clearAccessToken() {
  accessToken = null;
}
/** Impersonation tokens cannot be refreshed: use the token as-is and drop the session when it expires. */
let impersonating = false;
export function setImpersonationToken(token: string | null) {
  accessToken = token;
  impersonating = token !== null;
}

export function readCsrfCookie(): string {
  const m = document.cookie.split("; ").find((c) => c.startsWith("yl_csrf="));
  return m ? decodeURIComponent(m.slice("yl_csrf=".length)) : "";
}

/** Cross-origin deployments can't read the API's yl_csrf cookie; ask the API (CORS-gated) for it. */
async function fetchCsrfToken(): Promise<string> {
  try {
    const res = await fetchImpl(`${apiBase()}/auth/csrf`, { credentials: "include" });
    if (!res.ok) return "";
    const body = (await res.json()) as { csrfToken?: string };
    return body.csrfToken ?? "";
  } catch {
    return "";
  }
}

export interface Opts<T> {
  method?: string;
  body?: unknown;
  auth?: boolean;
  csrf?: boolean;
  schema?: z.ZodType<T>;
  retry?: boolean;
}

export async function request<T = void>(path: string, o: Opts<T> = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  if (o.auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (o.csrf) headers["X-CSRF-Token"] = readCsrfCookie() || (await fetchCsrfToken());

  let res: Response;
  try {
    res = await fetchImpl(`${apiBase()}${path}`, {
      method: o.method ?? "GET",
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      credentials: "include", // only ever sent to the configured API origin
    });
  } catch {
    throw new ApiError(0, "network_error", "Cannot reach the server. Check your connection.");
  }

  if (res.status === 401 && o.auth && impersonating) {
    accessToken = null;
    impersonating = false;
    onSessionLost?.();
  } else if (res.status === 401 && o.auth && o.retry !== false) {
    const s = await refreshSession();
    if (s) return request<T>(path, { ...o, retry: false });
  }

  if (!res.ok) {
    let parsed: z.infer<typeof errorEnvelopeSchema> | null = null;
    try {
      const r = errorEnvelopeSchema.safeParse(await res.json());
      parsed = r.success ? r.data : null;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(
      res.status,
      parsed?.error.code ?? "http_error",
      parsed?.error.message ?? `Request failed (${res.status})`,
      parsed?.error.requestId,
      parsed?.error.details,
    );
  }
  if (res.status === 204 || !o.schema) return undefined as T;
  return o.schema.parse(await res.json());
}

function adopt(s: Session): Session {
  accessToken = s.accessToken;
  return s;
}

/** Single-flight refresh using httpOnly cookie + CSRF header. Resolves null if no session. */
export function refreshSession(): Promise<Session | null> {
  refreshing ??= request("/auth/refresh", { method: "POST", csrf: true, schema: sessionSchema, retry: false })
    .then(adopt)
    .catch(() => {
      accessToken = null;
      onSessionLost?.();
      return null;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

export const api = {
  login: (b: LoginRequest) =>
    request("/auth/login", { method: "POST", body: b, schema: sessionSchema }).then(adopt),
  register: (b: RegisterRequest) =>
    request("/auth/register", { method: "POST", body: b, schema: sessionSchema }).then(adopt),
  /** Public: accept a team invitation (the emailed token is the credential), then the person signs in normally. */
  acceptInvite: (b: { token: string; name: string; password: string }) =>
    request<{ ok: true; role: string }>("/invitations/accept", { method: "POST", body: b }),
  logout: async () => {
    try {
      await request("/auth/logout", { method: "POST", csrf: true, retry: false });
    } finally {
      accessToken = null;
    }
  },
  /** Public: redeem the one-time code an admin console produced (60 s, single use). Returns a 15 minute impersonation session. */
  exchangeImpersonation: (code: string): Promise<ImpersonationSession> =>
    request("/auth/impersonation/exchange", { method: "POST", body: { code }, schema: impersonationSessionSchema }),
  me: (): Promise<Me> => request("/me", { auth: true, schema: meSchema }),
};
