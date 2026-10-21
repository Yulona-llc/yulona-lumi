import { createHmac, timingSafeEqual } from "node:crypto";

/** Thrown by adapters when sending fails. `retryable` drives queue retry vs dead-letter. */
export class ChannelSendError extends Error {
  constructor(
    message: string,
    public readonly code: "window_closed" | "rejected" | "unavailable" | "bad_credentials" | "invalid_destination",
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface AdapterOptions {
  /** Injected in tests to point at a mock HTTP server. */
  fetch?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Compare equal-length digests so the length of the secret never leaks through timing.
  const ha = createHmac("sha256", "yulona-cmp").update(ab).digest();
  const hb = createHmac("sha256", "yulona-cmp").update(bb).digest();
  return timingSafeEqual(ha, hb) && ab.length === bb.length;
}

export function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

export function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** `X-Hub-Signature-256: sha256=<hex>` check shared by WhatsApp, Messenger and Instagram. */
export function verifyMetaSignature(headers: Record<string, string | undefined>, rawBody: string, appSecret: string | undefined): boolean {
  if (!appSecret) return false;
  const sig = header(headers, "x-hub-signature-256");
  if (!sig || !sig.startsWith("sha256=")) return false;
  return constantTimeEqual(sig.slice(7), hmacHex(appSecret, rawBody));
}

/** Meta GET handshake: `hub.mode=subscribe` + matching verify token -> echo `hub.challenge`. */
export function metaHandshake(query: Record<string, string | undefined> | undefined, verifyToken: string | undefined): { status: number; body: string } | null {
  if (!query || query["hub.mode"] === undefined) return null;
  const ok = query["hub.mode"] === "subscribe" && !!verifyToken && constantTimeEqual(query["hub.verify_token"] ?? "", verifyToken);
  return ok ? { status: 200, body: query["hub.challenge"] ?? "" } : { status: 403, body: "forbidden" };
}

export function safeJson(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** POST/GET JSON with timeout; maps network errors and HTTP statuses onto ChannelSendError. */
export async function callApi(
  opts: AdapterOptions,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown },
  what: string,
): Promise<any> {
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, {
      method: init.method ?? "POST",
      headers: { "content-type": "application/json", ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      redirect: "error",
    });
  } catch (e) {
    throw new ChannelSendError(`${what}: network error`, "unavailable", true);
  }
  const text = await res.text();
  const data = safeJson(text);
  if (res.status === 401 || res.status === 403) throw new ChannelSendError(`${what}: credentials rejected (${res.status})`, "bad_credentials", false);
  if (res.status === 429 || res.status >= 500) throw new ChannelSendError(`${what}: temporary failure (${res.status})`, "unavailable", true);
  if (!res.ok) {
    const detail = String(data?.error?.message ?? data?.description ?? "").slice(0, 200);
    throw new ChannelSendError(`${what}: rejected (${res.status}) ${detail}`.trim(), "rejected", false);
  }
  return data;
}
