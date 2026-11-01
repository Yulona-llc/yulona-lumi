import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = ["pdf", "docx", "txt", "md", "html", "htm"] as const;
export type FileKind = "pdf" | "docx" | "text" | "html";

export class UnsupportedFileError extends Error {}

const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/g;
/**
 * Clean extracted text without losing paragraph structure: every kind of space (tabs, NBSP, ideographic, line
 * separators) becomes one space, trailing/leading spaces on a line go, line endings become `\n`, and runs of
 * blank lines collapse to one blank line. Used on every text branch before sectionizing.
 */
export function normalizeWs(text: string): string {
  return text
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n")
    .replace(INVISIBLE, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
/** Single-line variant for titles, names and descriptions: all whitespace runs become one space. */
export const normalizeInline = (s: string): string => s.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();

const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|igshid$|_ga$)/i;
/**
 * Canonical form used to dedupe crawl URLs: http(s) only, lowercase host, no fragment, no default port, no tracking
 * parameters, sorted query, no duplicate/trailing slashes and no `index.html`. Returns null when not http(s).
 */
export function normalizeUrl(raw: string, base?: string | URL): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = "";
  for (const [k, v] of keep) u.searchParams.append(k, v);
  let path = u.pathname.replace(/\/{2,}/g, "/").replace(/\/index\.html?$/i, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  u.pathname = path || "/";
  return u.toString();
}

function ext(name: string): string {
  return name.toLowerCase().split(".").pop() ?? "";
}

function looksLikeText(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8192);
  for (let i = 0; i < n; i++) if (b[i] === 0) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, n));
    return true;
  } catch {
    // may have cut a multibyte char at the boundary
    return n === b.length ? false : new TextDecoder("utf-8").decode(b.subarray(0, n)).split("�").length <= 2;
  }
}

/** Detect by magic bytes (never trust the client mime/extension alone) and cross-check the extension. */
export function detectFileKind(name: string, bytes: Uint8Array): FileKind {
  if (bytes.length === 0) throw new UnsupportedFileError("file is empty");
  if (bytes.length > MAX_FILE_BYTES) throw new UnsupportedFileError("file too large");
  const e = ext(name);
  if (!(ALLOWED_EXTENSIONS as readonly string[]).includes(e)) throw new UnsupportedFileError(`unsupported file type .${e}`);
  const isPdf = bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (e === "pdf") {
    if (!isPdf) throw new UnsupportedFileError("file content is not a PDF");
    return "pdf";
  }
  if (e === "docx") {
    if (!isZip) throw new UnsupportedFileError("file content is not a DOCX");
    return "docx";
  }
  if (isPdf || isZip || (bytes[0] === 0x4d && bytes[1] === 0x5a) || (bytes[0] === 0x7f && bytes[1] === 0x45)) {
    throw new UnsupportedFileError("file content does not match its extension");
  }
  if (!looksLikeText(bytes)) throw new UnsupportedFileError("file is not valid UTF-8 text");
  return e === "html" || e === "htm" ? "html" : "text";
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === "#") {
      const code = g[1]!.toLowerCase() === "x" ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): { title: string | null; text: string } {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, inner: string) => `\n\n${"#".repeat(Number(n))} ${normalizeInline(inner.replace(/<[^>]+>/g, " "))}\n\n`)
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article|\/ul|\/ol|\/table)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return {
    title: title ? normalizeInline(decodeEntities(title)) || null : null,
    text: normalizeWs(decodeEntities(text)),
  };
}

const NON_PAGE = /\.(png|jpe?g|gif|svg|css|js|mjs|zip|gz|tar|ico|webp|avif|mp4|mp3|wav|mov|woff2?|ttf|eot|xml|json|exe|dmg)$/i;
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

/**
 * http(s) links found in an HTML page, normalized (`normalizeUrl`) and deduped. Honours `<base href>` and skips
 * `rel="nofollow"` links and obvious non-pages (images, scripts, archives). By default only same-origin links are
 * returned; pass `accept` to apply a different rule (for example same site including subdomains).
 */
export function extractLinks(html: string, pageUrl: URL, accept: (u: URL) => boolean = (u) => u.origin === pageUrl.origin): string[] {
  let base = pageUrl;
  const baseTag = /<base\s[^>]*>/i.exec(html);
  const baseHref = baseTag ? attr(baseTag[0], "href") : null;
  if (baseHref) {
    try {
      base = new URL(decodeEntities(baseHref), pageUrl);
    } catch {
      /* ignore a broken <base> */
    }
  }
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*>/gi)) {
    const href = attr(m[0], "href");
    if (!href || /^\s*#/.test(href)) continue;
    if (/\bnofollow\b/i.test(attr(m[0], "rel") ?? "")) continue;
    const norm = normalizeUrl(decodeEntities(href), base);
    if (!norm) continue;
    const u = new URL(norm);
    if (NON_PAGE.test(u.pathname) || !accept(u)) continue;
    out.add(norm);
  }
  return [...out];
}

export async function extractFromFile(name: string, bytes: Uint8Array): Promise<string> {
  const kind = detectFileKind(name, bytes);
  switch (kind) {
    case "pdf": {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: true });
      return normalizeWs(Array.isArray(text) ? text.join("\n\n") : text);
    }
    case "docx": {
      const r = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      return normalizeWs(r.value);
    }
    case "html":
      return htmlToText(new TextDecoder().decode(bytes)).text;
    default:
      return normalizeWs(new TextDecoder().decode(bytes));
  }
}
