import { extractText, getDocumentProxy } from "unpdf";
import mammoth from "mammoth";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = ["pdf", "docx", "txt", "md", "html", "htm"] as const;
export type FileKind = "pdf" | "docx" | "text" | "html";

export class UnsupportedFileError extends Error {}

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
    .replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, inner: string) => `\n\n${"#".repeat(Number(n))} ${inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}\n\n`)
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/section|\/article|\/ul|\/ol|\/table)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return {
    title: title ? decodeEntities(title).replace(/\s+/g, " ").trim() : null,
    text: decodeEntities(text).replace(/[ \t\f\v]+/g, " ").replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
}

/** Same-origin http(s) links found in an HTML page (fragment-stripped, deduped). */
export function extractLinks(html: string, base: URL): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)[^"']*["']/gi)) {
    try {
      const u = new URL(decodeEntities(m[1]!), base);
      if ((u.protocol === "http:" || u.protocol === "https:") && u.origin === base.origin && !/\.(png|jpe?g|gif|svg|css|js|zip|ico|webp|mp4)$/i.test(u.pathname)) {
        u.hash = "";
        out.add(u.toString());
      }
    } catch {
      /* ignore */
    }
  }
  return [...out];
}

export async function extractFromFile(name: string, bytes: Uint8Array): Promise<string> {
  const kind = detectFileKind(name, bytes);
  switch (kind) {
    case "pdf": {
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const { text } = await extractText(pdf, { mergePages: true });
      return (Array.isArray(text) ? text.join("\n\n") : text).trim();
    }
    case "docx": {
      const r = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      return r.value.trim();
    }
    case "html":
      return htmlToText(new TextDecoder().decode(bytes)).text;
    default:
      return new TextDecoder().decode(bytes).trim();
  }
}
