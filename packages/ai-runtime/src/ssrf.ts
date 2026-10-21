import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfError extends Error {}

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
}
const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** True for loopback, private, link-local, CGNAT, multicast, reserved and unspecified addresses. */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const n = v4ToInt(ip);
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (v4ToInt(base) & mask);
    });
  }
  if (kind === 6) {
    const s = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isBlockedIp(mapped[1]!);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1]!, 16), lo = parseInt(mappedHex[2]!, 16);
      return isBlockedIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (s === "::" || s === "::1") return true;
    const first = parseInt(s.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (s.startsWith("64:ff9b:") || s.startsWith("2001:db8")) return true;
    return false;
  }
  return true; // not an IP => caller bug; fail closed
}

export type Resolver = (hostname: string) => Promise<string[]>;
export const defaultResolver: Resolver = async (h) => (await lookup(h, { all: true })).map((r) => r.address);

/** Validate a URL for outbound fetches: http(s) only, no credentials, host resolves to public IPs only. */
export async function assertSafeUrl(raw: string, resolver: Resolver = defaultResolver): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SsrfError("invalid URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new SsrfError("only http/https URLs are allowed");
  if (u.username || u.password) throw new SsrfError("URLs with credentials are not allowed");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new SsrfError("host not allowed");
  }
  const addrs = isIP(host) ? [host] : await resolver(host).catch(() => { throw new SsrfError("host did not resolve"); });
  if (!addrs.length || addrs.some(isBlockedIp)) throw new SsrfError("host resolves to a non-public address");
  return u;
}

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  /** Extra (lowercase) header names that carry credentials; stripped when a redirect changes origin. */
  sensitiveHeaders?: string[];
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  resolver?: Resolver;
  fetchImpl?: typeof fetch;
}
/** Headers always treated as credentials on a cross-origin redirect. */
export const CREDENTIAL_HEADERS = ["authorization", "proxy-authorization", "x-api-key", "x-yulona-signature", "x-yulona-timestamp", "cookie"];

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string;
  body: Uint8Array;
}

/**
 * SSRF-safe fetch: every hop (including redirects) is re-validated, bodies and wall time are capped.
 * NOTE: DNS is resolved by the validator and again by fetch; run workers behind an egress firewall
 * that blocks private ranges to close the residual DNS-rebinding window (see docs/api/ai-runtime.md).
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const f = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const deadline = Date.now() + (opts.timeoutMs ?? 15_000);
  let url = rawUrl;
  let method = opts.method ?? "GET";
  let body = opts.body;
  let headers: Record<string, string> = { "user-agent": "YulonaBot/1.0", accept: "*/*", ...opts.headers };
  const sensitive = new Set([...CREDENTIAL_HEADERS, ...(opts.sensitiveHeaders ?? []).map((h) => h.toLowerCase())]);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    const u = await assertSafeUrl(url, opts.resolver);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new SsrfError("request timed out");
    const res = await f(u, {
      method,
      body,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(remaining),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const next = new URL(res.headers.get("location")!, u);
      const crossOrigin = next.origin !== u.origin;
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers = Object.fromEntries(Object.entries(headers).filter(([k]) => k.toLowerCase() !== "content-type" && k.toLowerCase() !== "content-length"));
      } else if (crossOrigin && body !== undefined) {
        // 307/308 would replay the (possibly signed) body to another origin: refuse.
        await res.body?.cancel();
        throw new SsrfError("redirect with a request body to another origin refused");
      }
      if (crossOrigin) headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !sensitive.has(k.toLowerCase())));
      url = next.toString();
      await res.body?.cancel();
      continue;
    }
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > maxBytes) throw new SsrfError("response too large");
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new SsrfError("response too large");
      }
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return { url: u.toString(), status: res.status, contentType: res.headers.get("content-type") ?? "", body: out };
  }
  throw new SsrfError("too many redirects");
}
