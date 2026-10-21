/**
 * Origin allowlist matching for the public widget API.
 * Patterns: `example.com`, `*.example.com` (subdomains only), optional `https://` and `:port`.
 * An empty list denies everything, except localhost/127.0.0.1 outside production (development).
 */
export function originAllowed(origin: string | undefined | null, patterns: readonly string[], isProd: boolean): boolean {
  if (!origin || origin === "null") return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (patterns.length === 0) return !isProd && (host === "localhost" || host === "127.0.0.1");
  const effectivePort = u.port || (u.protocol === "https:" ? "443" : "80");
  for (const raw of patterns) {
    const m = /^(?:(https?):\/\/)?(\*\.)?([^:/]+)(?::(\d+))?$/.exec(raw.toLowerCase());
    if (!m) continue;
    const [, scheme, wild, base, port] = m;
    if (scheme && `${scheme}:` !== u.protocol) continue;
    if (port && port !== effectivePort) continue;
    if (wild ? host.endsWith(`.${base}`) : host === base) return true;
  }
  return false;
}
