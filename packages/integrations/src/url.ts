import { isIP } from "node:net";
import { isBlockedIp } from "@yulona/ai-runtime";

/**
 * Synchronous, DNS-free validation used when a webhook is saved. The authoritative SSRF check (DNS
 * resolution to public addresses only) runs at every delivery attempt in `deliverWebhook`.
 * Returns an error message, or null when acceptable.
 */
export function webhookUrlProblem(raw: string, opts: { allowHttp: boolean }): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "Invalid URL";
  }
  if (u.protocol !== "https:" && !(opts.allowHttp && u.protocol === "http:")) return opts.allowHttp ? "URL must be http(s)" : "URL must use https";
  if (u.username || u.password) return "URLs with credentials are not allowed";
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return "URL has no host";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return "Host not allowed";
  if (isIP(host) && isBlockedIp(host)) return "Host not allowed";
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return "Host not allowed"; // integer / hex IPv4 forms
  return null;
}
