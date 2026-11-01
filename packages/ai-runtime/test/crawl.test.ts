import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import JSZip from "jszip";
import { withTenant } from "@yulona/db";
import { SKIP_MESSAGE, testUrls } from "@yulona/db/testing";
import {
  CRAWL_USER_AGENT, CrawlBlockedError, crawl, hostAllowed, parseRobots, resolveCrawlConfig,
} from "../src/crawl";
import { extractFromFile, extractLinks, htmlToText, normalizeInline, normalizeUrl, normalizeWs } from "../src/extract";
import { ingestSource } from "../src/ingest";
import { KnowledgeRepository } from "../src/knowledge-repo";
import { describeSkill, sectionize } from "../src/sections";
import { seedTenant, setupAiDb, type TestEnv } from "./helpers";

// ---------------------------------------------------------------- fixtures
type Page = { body?: string; type?: string; status?: number; location?: string };
const html = (body: string, title = "Page") => `<html><head><title>${title}</title></head><body>${body}</body></html>`;
const PUBLIC = "93.184.216.34";
const para = (s: string) => `<p>${s} ${"filler words to make this paragraph long enough to keep. ".repeat(3)}</p>`;

/** A fake web: URL -> response. Logs every request (URL + user agent). */
function web(pages: Record<string, Page>) {
  const log: { url: string; ua: string | null }[] = [];
  const fetchImpl = (async (u: URL, init?: RequestInit) => {
    const url = String(u);
    log.push({ url, ua: new Headers(init?.headers).get("user-agent") });
    const p = pages[url];
    if (!p) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    if (p.location) return new Response(null, { status: p.status ?? 302, headers: { location: p.location } });
    return new Response(p.body ?? "", { status: p.status ?? 200, headers: { "content-type": p.type ?? "text/html; charset=utf-8" } });
  }) as unknown as typeof fetch;
  const hits = (url: string) => log.filter((l) => l.url === url).length;
  return { fetchImpl, log, hits };
}
const resolver = async (h: string) => (h === "internal.site.test" ? ["10.0.0.7"] : [PUBLIC]);
const fast = (w: ReturnType<typeof web>, extra: object = {}) => ({ fetchImpl: w.fetchImpl, resolver, delayMs: 0, sleep: async () => {}, ...extra });

/** root -> /a -> /a/b -> /a/b/c -> /a/b/c/d -> /a/b/c/d/e, each page links one level deeper (and back to the root) */
const chain = () => {
  const p: Record<string, Page> = {};
  const names = ["", "a", "a/b", "a/b/c", "a/b/c/d", "a/b/c/d/e"];
  names.forEach((n, i) => {
    const next = names[i + 1];
    p[`https://site.test/${n}`.replace(/\/$/, n ? "" : "/")] = { body: html(`<h1>Level ${i}</h1>${para(`level ${i}`)}${next ? `<a href="/${next}">next</a>` : ""}`, `Level ${i}`) };
  });
  return p;
};

// ---------------------------------------------------------------- config + url normalisation
describe("crawl config", () => {
  test("defaults: depth 3, follow links when more than one page, caps 50 pages and depth 1-5", () => {
    expect(resolveCrawlConfig({ maxPages: 25 })).toEqual({ maxPages: 25, maxDepth: 3, followLinks: true, includeSubdomains: false });
    expect(resolveCrawlConfig({})).toMatchObject({ maxPages: 1, followLinks: false, maxDepth: 3 });
    expect(resolveCrawlConfig({ maxPages: 500, maxDepth: 99 })).toMatchObject({ maxPages: 50, maxDepth: 5 });
    expect(resolveCrawlConfig({ maxPages: 0, maxDepth: 0 })).toMatchObject({ maxPages: 1, maxDepth: 1 });
    expect(resolveCrawlConfig({ maxPages: 10, followLinks: false }).followLinks).toBe(false);
  });
  test("normalizeUrl dedupes host case, fragments, default ports, tracking params, slashes and index.html", () => {
    const same = [
      "https://Site.test/pricing", "https://site.test:443/pricing/", "https://site.test/pricing#plans", "https://site.test/pricing?utm_source=x&utm_medium=y",
      "https://site.test//pricing", "https://site.test/pricing?fbclid=1",
    ];
    expect(new Set(same.map((u) => normalizeUrl(u))).size).toBe(1);
    expect(normalizeUrl("https://site.test/index.html")).toBe("https://site.test/");
    expect(normalizeUrl("/x?b=2&a=1", "https://site.test/")).toBe(normalizeUrl("https://site.test/x?a=1&b=2"));
    expect(normalizeUrl("https://site.test/x?id=1")).not.toBe(normalizeUrl("https://site.test/x?id=2"));
    expect(normalizeUrl("mailto:a@b.co")).toBeNull();
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
  });
  test("extractLinks honours rel=nofollow and <base href>, skips assets and other origins", () => {
    const page = `<base href="https://site.test/docs/"><a href="intro">i</a><a href="/x" rel="nofollow">n</a><a href="y" rel="noopener NOFOLLOW">n2</a>
      <a href="logo.png">l</a><a href="https://other.test/z">o</a><a href='single'>s</a><a href="#top">t</a><a href="mailto:a@b.co">m</a>`;
    expect(extractLinks(page, new URL("https://site.test/start")).sort()).toEqual(["https://site.test/docs/intro", "https://site.test/docs/single"]);
  });
  test("host rule: same host (www ignored); subdomains only when asked and never lookalikes", () => {
    const root = new URL("https://site.test/");
    const ok = (u: string, sub = false) => hostAllowed(root, new URL(u), sub);
    expect(ok("https://www.site.test/a")).toBe(true);
    expect(ok("https://blog.site.test/a")).toBe(false);
    expect(ok("https://blog.site.test/a", true)).toBe(true);
    expect(ok("https://notsite.test/a", true)).toBe(false);
    expect(ok("https://site.test.evil.test/a", true)).toBe(false);
    expect(ok("https://site.test:8443/a")).toBe(false);
  });
});

// ---------------------------------------------------------------- robots.txt
describe("robots.txt", () => {
  test("longest match wins, wildcards and $, specific group beats *", () => {
    const r = parseRobots(`User-agent: *\nDisallow: /private\nAllow: /private/open\nDisallow: /*.pdf$\nCrawl-delay: 3\n\nUser-agent: lumibot\nDisallow: /secret # comment\n`);
    expect(r.allows("/secret/x")).toBe(false);
    expect(r.allows("/private/x")).toBe(true); // the lumibot group replaces *
    expect(r.crawlDelayMs).toBe(0);
    const star = parseRobots(`User-agent: *\nDisallow: /private\nAllow: /private/open\nDisallow: /*.pdf$\nCrawl-delay: 3`);
    expect(star.allows("/private/x")).toBe(false);
    expect(star.allows("/private/open/x")).toBe(true);
    expect(star.allows("/a/file.pdf")).toBe(false);
    expect(star.allows("/a/file.pdf?x=1")).toBe(true);
    expect(star.crawlDelayMs).toBe(3000);
    expect(parseRobots("User-agent: *\nDisallow:\n").allows("/anything")).toBe(true);
    expect(parseRobots("User-agent: *\nDisallow: /\n").allows("/")).toBe(false);
    expect(parseRobots("User-agent: *\nCrawl-delay: 600").crawlDelayMs).toBe(10_000);
  });

  test("the crawl fetches robots.txt once, skips disallowed pages, waits Crawl-delay and sends the User-Agent", async () => {
    const w = web({
      "https://site.test/robots.txt": { body: "User-agent: *\nDisallow: /private\nCrawl-delay: 2\n", type: "text/plain" },
      "https://site.test/": { body: html(`<h1>Home</h1>${para("home")}<a href="/private/plans">p</a><a href="/open">o</a><a href="/open2">o2</a>`) },
      "https://site.test/private/plans": { body: html(para("secret plans")) },
      "https://site.test/open": { body: html(para("open page")) },
      "https://site.test/open2": { body: html(para("open page two")) },
    });
    const sleeps: number[] = [];
    const r = await crawl("https://site.test/", { maxPages: 10 }, fast(w, { sleep: async (ms: number) => void sleeps.push(ms) }));
    expect(r.pages.map((p) => p.metadata.url).sort()).toEqual(["https://site.test/", "https://site.test/open", "https://site.test/open2"]);
    expect(w.hits("https://site.test/private/plans")).toBe(0);
    expect(w.hits("https://site.test/robots.txt")).toBe(1);
    expect(r.progress.pagesSkipped).toBe(1);
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((ms) => ms >= 1900 && ms <= 2000)).toBe(true);
    expect(new Set(w.log.map((l) => l.ua))).toEqual(new Set([CRAWL_USER_AGENT]));
  });

  test("production default waits about 500 ms between requests", async () => {
    const w = web({
      "https://site.test/": { body: html(`${para("home")}<a href="/b">b</a>`) },
      "https://site.test/b": { body: html(para("b page")) },
    });
    const sleeps: number[] = [];
    let t = 1_000;
    await crawl("https://site.test/", { maxPages: 5 }, { fetchImpl: w.fetchImpl, resolver, sleep: async (ms) => void (sleeps.push(ms), (t += ms)), now: () => t });
    expect(sleeps.length).toBe(2); // robots -> home, home -> b
    expect(sleeps.every((ms) => ms === 500)).toBe(true);
  });

  test("a robots.txt that blocks the first page ends the crawl as a permanent error", async () => {
    const w = web({ "https://site.test/robots.txt": { body: "User-agent: *\nDisallow: /\n", type: "text/plain" }, "https://site.test/": { body: html(para("x")) } });
    await expect(crawl("https://site.test/", { maxPages: 5 }, fast(w))).rejects.toBeInstanceOf(CrawlBlockedError);
    expect(w.hits("https://site.test/")).toBe(0);
  });

  test("a missing or broken robots.txt means no rules", async () => {
    const w = web({ "https://site.test/robots.txt": { status: 500, body: "boom" }, "https://site.test/": { body: html(para("x")) } });
    expect((await crawl("https://site.test/", { maxPages: 2 }, fast(w))).pages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- depth, dedupe, limits
describe("crawl walk", () => {
  test("depth limit: links are followed only while depth < maxDepth", async () => {
    for (const [maxDepth, expected] of [[1, 2], [2, 3], [3, 4], [5, 6]] as const) {
      const w = web(chain());
      const r = await crawl("https://site.test/", { maxPages: 50, maxDepth }, fast(w));
      expect(r.pages.length).toBe(expected);
      expect(Math.max(...r.pages.map((p) => p.metadata.depth!))).toBe(maxDepth);
    }
    const w = web(chain());
    expect((await crawl("https://site.test/", { maxPages: 50 }, fast(w))).pages).toHaveLength(4); // default depth 3
  });

  test("followLinks off reads only the page given, whatever maxPages says", async () => {
    const w = web(chain());
    const r = await crawl("https://site.test/", { maxPages: 20, followLinks: false }, fast(w));
    expect(r.pages).toHaveLength(1);
    expect(w.log.filter((l) => !l.url.endsWith("/robots.txt"))).toHaveLength(1);
  });

  test("duplicate URL spellings are fetched once; maxPages is respected", async () => {
    const w = web({
      "https://site.test/": { body: html(`${para("home")}<a href="/x">1</a><a href="/x/">2</a><a href="/x#frag">3</a><a href="/x?utm_source=a">4</a><a href="https://www.site.test/x">5</a><a href="//site.test/x">6</a>
        <a href="/p1">p1</a><a href="/p2">p2</a><a href="/p3">p3</a>`) },
      "https://site.test/x": { body: html(para("the x page")) },
      "https://www.site.test/x": { body: html(para("the x page via www")) },
      "https://site.test/p1": { body: html(para("p1")) }, "https://site.test/p2": { body: html(para("p2")) }, "https://site.test/p3": { body: html(para("p3")) },
    });
    const r = await crawl("https://site.test/", { maxPages: 3 }, fast(w));
    expect(w.hits("https://site.test/x")).toBe(1);
    expect(w.hits("https://www.site.test/x")).toBe(0);
    expect(r.pages).toHaveLength(3);
    const all = await crawl("https://site.test/", { maxPages: 50 }, fast(web({ ...{}, "https://site.test/": { body: html(`${para("home")}<a href="/x">1</a><a href="/x/">2</a><a href="/X">3</a>`) }, "https://site.test/x": { body: html(para("x")) }, "https://site.test/X": { body: html(para("X case differs")) } })));
    expect(all.pages).toHaveLength(3); // paths are case sensitive
  });

  test("non-text content types and error pages are skipped, nofollow and <base> are honoured", async () => {
    const w = web({
      "https://site.test/": { body: html(`<base href="https://site.test/docs/">${para("home")}<a href="guide">g</a><a href="data">d</a><a href="photo">p</a><a href="gone">x</a><a href="skip" rel="nofollow">n</a><a href="notes.txt">t</a>`) },
      "https://site.test/docs/guide": { body: html(para("the guide")) },
      "https://site.test/docs/data": { body: "{}", type: "application/json" },
      "https://site.test/docs/photo": { body: "PNG", type: "image/png" },
      "https://site.test/docs/gone": { status: 500, body: "x" },
      "https://site.test/docs/skip": { body: html(para("nofollow target")) },
      "https://site.test/docs/notes.txt": { body: "Plain   text\t file\r\n\r\n\r\n\r\nwith   gaps", type: "text/plain" },
    });
    const r = await crawl("https://site.test/", { maxPages: 20 }, fast(w));
    expect(r.pages.map((p) => p.metadata.url).sort()).toEqual(["https://site.test/", "https://site.test/docs/guide", "https://site.test/docs/notes.txt"]);
    expect(w.hits("https://site.test/docs/skip")).toBe(0);
    expect(r.pages.find((p) => p.metadata.url.endsWith("notes.txt"))!.text).toBe("Plain text file\n\nwith gaps");
    expect(r.progress.pagesSkipped).toBe(3);
  });

  test("a non-text first page is an error, an HTTP error on the first page is an error", async () => {
    await expect(crawl("https://site.test/", {}, fast(web({ "https://site.test/": { body: "{}", type: "application/json" } })))).rejects.toThrow(/unsupported content type/);
    await expect(crawl("https://site.test/", {}, fast(web({ "https://site.test/": { status: 503, body: "x" } })))).rejects.toThrow(/HTTP 503/);
  });

  test("progress is reported after every page and ends done", async () => {
    const w = web(chain());
    const seen: { pagesCrawled: number; pagesFound: number; done: boolean }[] = [];
    const r = await crawl("https://site.test/", { maxPages: 50, maxDepth: 2 }, fast(w, { onProgress: (p: { pagesCrawled: number; pagesFound: number; done: boolean }) => void seen.push({ ...p }) }));
    expect(seen.map((s) => s.pagesCrawled)).toEqual([1, 2, 3, 3]);
    expect(seen.at(-1)).toMatchObject({ done: true, pagesCrawled: 3 });
    expect(r.progress.pagesFound).toBeGreaterThanOrEqual(3);
  });

  test("the time budget stops the crawl and keeps what it has", async () => {
    const w = web(chain());
    let t = 0;
    const r = await crawl("https://site.test/", { maxPages: 50, maxDepth: 5 }, fast(w, { budgetMs: 1000, now: () => (t += 400) }));
    expect(r.progress.truncated).toBe(true);
    expect(r.pages.length).toBeGreaterThan(0);
    expect(r.pages.length).toBeLessThan(6);
  });
});

// ---------------------------------------------------------------- subdomains + SSRF
describe("crawl scope and SSRF", () => {
  const pages = () => ({
    "https://site.test/": { body: html(`${para("home")}<a href="https://blog.site.test/post">blog</a><a href="https://other.test/x">other</a><a href="/local">l</a><a href="https://notsite.test/">lookalike</a><a href="/redir">r</a>`) },
    "https://site.test/local": { body: html(para("local page")) },
    "https://blog.site.test/post": { body: html(para("a blog post")) },
    "https://other.test/x": { body: html(para("another site")) },
    "https://notsite.test/": { body: html(para("lookalike")) },
    "https://site.test/redir": { location: "https://other.test/x" },
  });
  test("subdomains are skipped by default and followed only with includeSubdomains; other sites never", async () => {
    const off = web(pages());
    const a = await crawl("https://site.test/", { maxPages: 20 }, fast(off));
    expect(a.pages.map((p) => p.metadata.url).sort()).toEqual(["https://site.test/", "https://site.test/local"]);
    const on = web(pages());
    const b = await crawl("https://site.test/", { maxPages: 20, includeSubdomains: true }, fast(on));
    expect(b.pages.map((p) => p.metadata.url).sort()).toEqual(["https://blog.site.test/post", "https://site.test/", "https://site.test/local"]);
    expect(on.hits("https://other.test/x")).toBe(1); // only the redirect hop; its page is dropped by the final-host check
    expect(b.pages.some((p) => p.metadata.url.includes("other.test"))).toBe(false);
    expect(on.hits("https://notsite.test/")).toBe(0);
  });

  test("a redirect to another site is dropped after safeFetch resolves the final host", async () => {
    const w = web({ "https://site.test/": { body: html(`${para("home")}<a href="/redir">r</a>`) }, "https://site.test/redir": { location: "https://other.test/x" }, "https://other.test/x": { body: html(para("elsewhere")) } });
    const r = await crawl("https://site.test/", { maxPages: 5 }, fast(w));
    expect(r.pages.map((p) => p.metadata.url)).toEqual(["https://site.test/"]);
  });

  test("the root may redirect (apex to www) and the site becomes the final host", async () => {
    const w = web({ "https://site.test/": { location: "https://www.site.test/" }, "https://www.site.test/": { body: html(`${para("home")}<a href="/b">b</a>`) }, "https://www.site.test/b": { body: html(para("b page")) } });
    const r = await crawl("https://site.test/", { maxPages: 5 }, fast(w));
    expect(r.pages).toHaveLength(2);
  });

  test("SSRF: discovered links to private addresses or hosts that resolve privately are never fetched (robots.txt included)", async () => {
    const w = web({
      "https://site.test/": { body: html(`${para("home")}<a href="http://169.254.169.254/latest/meta-data">m</a><a href="http://127.0.0.1:8080/admin">l</a><a href="https://internal.site.test/secret">i</a><a href="http://localhost/x">lh</a><a href="/ok">ok</a>`) },
      "https://site.test/ok": { body: html(para("ok page")) },
      "http://169.254.169.254/latest/meta-data": { body: html(para("metadata")) },
      "http://127.0.0.1:8080/admin": { body: html(para("admin")) },
      "https://internal.site.test/secret": { body: html(para("secret")) },
      "https://internal.site.test/robots.txt": { body: "User-agent: *\nAllow: /\n", type: "text/plain" },
    });
    const r = await crawl("https://site.test/", { maxPages: 20, includeSubdomains: true }, fast(w));
    expect(r.pages.map((p) => p.metadata.url).sort()).toEqual(["https://site.test/", "https://site.test/ok"]);
    expect(w.log.map((l) => l.url).filter((u) => /169\.254|127\.0\.0\.1|internal|localhost/.test(u))).toEqual([]);
  });

  test("SSRF: a public page that redirects to a private address is not followed", async () => {
    const w = web({ "https://site.test/": { body: html(`${para("home")}<a href="/go">go</a>`) }, "https://site.test/go": { location: "http://10.0.0.5/" }, "http://10.0.0.5/": { body: "private" } });
    const r = await crawl("https://site.test/", { maxPages: 5 }, fast(w));
    expect(r.pages).toHaveLength(1);
    expect(w.hits("http://10.0.0.5/")).toBe(0);
  });

  test("SSRF: a private root fails immediately", async () => {
    await expect(crawl("http://10.1.2.3/", {}, fast(web({})))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- whitespace
describe("whitespace cleaning", () => {
  test("normalizeWs: every kind of space, line endings, blank-line runs, invisible characters", () => {
    expect(normalizeWs("  a    b\t\tc 　 d  ")).toBe("a b c d");
    expect(normalizeWs("one\r\ntwo\rthree four")).toBe("one\ntwo\nthree\nfour");
    expect(normalizeWs("para one  \n\n\n\n\n   para two\n \n\n")).toBe("para one\n\npara two");
    expect(normalizeWs("zero​width﻿ joined­soft")).toBe("zerowidth joinedsoft");
    expect(normalizeWs("   \n\t \n")).toBe("");
    expect(normalizeInline("  A \n\n  heading\twith gaps ")).toBe("A heading with gaps");
  });

  test("titles: first line, heading paths and the page title are single-line and trimmed", () => {
    const secs = sectionize("#   Shipping   &   Returns  \n\nWe ship in five days.  \n\n##  Free \t returns \nWithin thirty days of purchase, no questions asked at all.", { minChars: 1 });
    expect(secs.map((s) => s.title)).toEqual(["Shipping & Returns", "Shipping & Returns › Free returns"]);
    const packed = sectionize(`    Opening   hours   \n${"We are open every weekday from nine until five o'clock. ".repeat(3)}`);
    expect(packed[0]!.title).toBe("Opening hours");
    expect(packed[0]!.title).not.toMatch(/\s{2,}|^\s|\s$|\n/);
    const h = htmlToText("<html><head><title>\n  Acme     Shop \n</title></head><body><h1>  Big \n  News </h1><p>Hello  world</p><p>   </p><p>again</p></body></html>");
    expect(h.title).toBe("Acme Shop");
    expect(h.text).toBe("# Big News\n\nHello world\n\nagain");
  });

  test("descriptions are one clean line", () => {
    const secs = sectionize("# Hours\n\nWe are   open\n\n\nfrom nine to five on weekdays.   Closed at weekends.", { minChars: 1 });
    const d = describeSkill(secs, "  My\n  shop  ");
    expect(d).not.toMatch(/\n|\s{2,}/);
    expect(d).toContain("We are open from nine to five on weekdays.");
    expect(describeSkill([], "  My\n  shop  ")).toBe("My shop");
  });

  test("plain text, PDF and DOCX extraction all come back clean", async () => {
    const messy = "First   line\t\there\r\n\r\n\r\n\r\n   Second  paragraph   \r\nthird line";
    const clean = "First line here\n\nSecond paragraph\nthird line";
    expect(await extractFromFile("a.txt", new TextEncoder().encode(messy))).toBe(clean);
    expect(await extractFromFile("a.md", new TextEncoder().encode(messy))).toBe(clean);
    expect(await extractFromFile("a.html", new TextEncoder().encode(`<p>${"First   line"}</p><p> Second \n  one</p>`))).toBe("First line\nSecond\none");

    // minimal PDF with extra spaces inside the text run
    const stream = "BT /F1 12 Tf 72 700 Td (Hello      PDF   world    again) Tj ET";
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const pdfText = await extractFromFile("a.pdf", new TextEncoder().encode(pdf));
    expect(pdfText).toContain("Hello");
    expect(pdfText).not.toMatch(/ {2,}|\n{3,}|^\s|\s$/);

    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.file("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t xml:space="preserve">Docx    first   paragraph  </w:t></w:r></w:p><w:p/><w:p/><w:p/><w:p><w:r><w:t xml:space="preserve">  Second   one here</w:t></w:r></w:p></w:body></w:document>`);
    const docx = await zip.generateAsync({ type: "uint8array" });
    expect(await extractFromFile("a.docx", docx)).toBe("Docx first paragraph\n\nSecond one here");
  });
});

// ---------------------------------------------------------------- ingest into the database
const enabled = !!testUrls();
if (!enabled) console.warn(SKIP_MESSAGE);
const d = enabled ? describe : describe.skip;
let env: TestEnv;
beforeAll(async () => {
  if (enabled) env = (await setupAiDb())!;
});
afterAll(async () => {
  if (enabled) await env.close();
});

d("url ingest end to end", () => {
  const site = () => web({
    "https://site.test/robots.txt": { body: "User-agent: *\nDisallow: /private\n", type: "text/plain" },
    "https://site.test/": { body: html(`<h1>  Welcome \n to   Acme </h1>${para("home")}<a href="/about">a</a><a href="/about/">dup</a><a href="/private/x">hidden</a><a href="/files/guide.txt">g</a>`, "  Acme \n   Home ") },
    "https://site.test/about": { body: html(`<h1>About  us</h1>${para("about")}<a href="/about/team">t</a>`, "About") },
    "https://site.test/about/team": { body: html(`<h1>Our   team</h1>${para("team")}<a href="/about/team/jo">jo</a>`) },
    "https://site.test/about/team/jo": { body: html(`<h1>Jo</h1>${para("jo")}<a href="/too/deep">deep</a>`) },
    "https://site.test/too/deep": { body: html(para("too deep")) },
    "https://site.test/private/x": { body: html(para("never read")) },
    "https://site.test/files/guide.txt": { body: "Guide   title\n\n\n\n   body\t text", type: "text/plain" },
  });

  test("depth 3 crawl: pages found, robots honoured, titles and text whitespace clean, progress saved", async () => {
    const t = await seedTenant(env.owner);
    const src = await withTenant(env.app, t, (tx) => new KnowledgeRepository(tx, t).create({
      type: "url", name: "  Acme \n site ", sourceUrl: "https://site.test/", crawlConfig: { maxPages: 25, maxDepth: 3, followLinks: true, includeSubdomains: false },
    }));
    const w = site();
    expect(await ingestSource({ db: env.app, fetchImpl: w.fetchImpl, resolver, crawlDelayMs: 0, crawlSleep: async () => {} }, { tenantId: t, sourceId: src.id })).toBe("ready");
    const rows = await env.owner<{ title: string; content: string; metadata: { url: string } }[]>`SELECT title, content, metadata FROM knowledge_chunks WHERE source_id = ${src.id} ORDER BY chunk_index`;
    const urls = [...new Set(rows.map((r) => r.metadata.url))].sort();
    expect(urls).toEqual(["https://site.test/", "https://site.test/about", "https://site.test/about/team", "https://site.test/about/team/jo", "https://site.test/files/guide.txt"]);
    expect(w.hits("https://site.test/too/deep")).toBe(0); // depth 4
    expect(w.hits("https://site.test/private/x")).toBe(0); // robots.txt
    for (const r of rows) {
      expect(r.title).not.toMatch(/\s{2,}|^\s|\s$|[\n\t ]/);
      expect(r.content).not.toMatch(/[ \t ]{2,}|\n{3,}|^\s|\s$|\r/);
    }
    expect(rows.some((r) => r.title.includes("Welcome to Acme"))).toBe(true);
    const [s] = await env.owner<{ status: string; description: string; crawlConfig: { progress: { pagesCrawled: number; pagesFound: number; done: boolean; pagesSkipped: number }; maxDepth: number } }[]>`
      SELECT status, description, crawl_config FROM knowledge_sources WHERE id = ${src.id}`;
    expect(s!.status).toBe("ready");
    expect(s!.description).not.toMatch(/\s{2,}|\n/);
    expect(s!.crawlConfig.maxDepth).toBe(3);
    expect(s!.crawlConfig.progress).toMatchObject({ pagesCrawled: 5, done: true, pagesSkipped: 1 });
    expect(s!.crawlConfig.progress.pagesFound).toBeGreaterThanOrEqual(6);
  });

  test("pasted text is normalised before sectionizing", async () => {
    const t = await seedTenant(env.owner);
    const src = await withTenant(env.app, t, (tx) => new KnowledgeRepository(tx, t).create({
      type: "text", name: "Notes", rawText: "#   Opening   hours \r\n\r\n\r\n\r\nWe are   open weekdays from nine to five.\t\tClosed on holidays.", sizeBytes: 10,
    }));
    expect(await ingestSource({ db: env.app }, { tenantId: t, sourceId: src.id })).toBe("ready");
    const [c] = await env.owner<{ title: string; content: string }[]>`SELECT title, content FROM knowledge_chunks WHERE source_id = ${src.id}`;
    expect(c!.title).toBe("Opening hours");
    expect(c!.content).toBe("We are open weekdays from nine to five. Closed on holidays.");
  });

  test("robots.txt blocking the first page fails the source permanently; a private root is a permanent failure too", async () => {
    const t = await seedTenant(env.owner);
    const mk = (url: string) => withTenant(env.app, t, (tx) => new KnowledgeRepository(tx, t).create({ type: "url", name: url, sourceUrl: url, crawlConfig: { maxPages: 5 } }));
    const blocked = await mk("https://site.test/");
    const w = web({ "https://site.test/robots.txt": { body: "User-agent: *\nDisallow: /\n", type: "text/plain" } });
    expect(await ingestSource({ db: env.app, fetchImpl: w.fetchImpl, resolver, crawlDelayMs: 0 }, { tenantId: t, sourceId: blocked.id })).toBe("failed");
    const [row] = await env.owner<{ status: string; error: string }[]>`SELECT status, error FROM knowledge_sources WHERE id = ${blocked.id}`;
    expect(row).toMatchObject({ status: "failed" });
    expect(row!.error).toContain("robots.txt");
    const priv = await mk("http://10.0.0.9/");
    expect(await ingestSource({ db: env.app, resolver, crawlDelayMs: 0 }, { tenantId: t, sourceId: priv.id })).toBe("failed");
  });
});
