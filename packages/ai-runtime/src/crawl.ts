import { UnsupportedFileError, extractFromFile, extractLinks, htmlToText, normalizeInline, normalizeUrl, normalizeWs } from "./extract";
import { safeFetch, type Resolver } from "./ssrf";

/** Crawl limits shared by the API schema, the stored `crawl_config` and the crawler. */
export const MAX_CRAWL_PAGES = 50;
export const DEFAULT_CRAWL_PAGES = 25;
export const DEFAULT_CRAWL_DEPTH = 3;
export const MAX_CRAWL_DEPTH = 5;
/** Polite gap between two requests to the same crawl (milliseconds). */
export const CRAWL_DELAY_MS = 500;
/** Longest `Crawl-delay` we honour (seconds); larger values are capped, not obeyed. */
const MAX_ROBOTS_DELAY_S = 10;
/** The job lock is 5 minutes (packages/queue), so a crawl stops itself before that and keeps what it has. */
const CRAWL_BUDGET_MS = 240_000;
const MAX_TEXT_CHARS = 2_000_000;
export const CRAWL_USER_AGENT = "LumiBot/1.0 (knowledge crawler; honours robots.txt)";
const ROBOTS_TOKEN = "lumibot";

export interface CrawlConfig {
  maxPages: number;
  maxDepth: number;
  followLinks: boolean;
  includeSubdomains: boolean;
}
export interface CrawlProgress {
  pagesCrawled: number;
  pagesFound: number;
  /** pages left out because of robots.txt, another site, an error or a non-text type */
  pagesSkipped: number;
  /** the crawl stopped early (time budget) and kept what it had */
  truncated?: boolean;
  done: boolean;
}
export interface CrawledPage {
  text: string;
  metadata: { url: string; title?: string; depth?: number } & Record<string, unknown>;
}

/** Fill defaults and clamp a stored/requested config. Old sources only had `maxPages` (default 1): they stay single-page. */
export function resolveCrawlConfig(raw: Partial<CrawlConfig> | null | undefined): CrawlConfig {
  const maxPages = Math.min(Math.max(Math.trunc(raw?.maxPages ?? 1), 1), MAX_CRAWL_PAGES);
  return {
    maxPages,
    maxDepth: Math.min(Math.max(Math.trunc(raw?.maxDepth ?? DEFAULT_CRAWL_DEPTH), 1), MAX_CRAWL_DEPTH),
    followLinks: raw?.followLinks ?? maxPages > 1,
    includeSubdomains: raw?.includeSubdomains ?? false,
  };
}

/** The crawler was told not to read the very first page (robots.txt). Never succeeds on retry. */
export class CrawlBlockedError extends Error {}

// ---------------------------------------------------------------------------------------------- robots.txt
export interface RobotsRules {
  allows(pathAndQuery: string): boolean;
  /** milliseconds, already capped */
  crawlDelayMs: number;
}
export const ALLOW_ALL: RobotsRules = { allows: () => true, crawlDelayMs: 0 };

interface Group {
  agents: string[];
  rules: { allow: boolean; re: RegExp; len: number }[];
  delay: number | null;
}
function patternToRegExp(p: string): RegExp {
  const anchored = p.endsWith("$");
  const body = (anchored ? p.slice(0, -1) : p).split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/** Minimal robots.txt parser: User-agent groups, Allow/Disallow with `*` and `$`, longest match wins, `Crawl-delay`. */
export function parseRobots(text: string, token = ROBOTS_TOKEN): RobotsRules {
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [], delay: null }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!cur) continue;
    if ((key === "allow" || key === "disallow") && val) cur.rules.push({ allow: key === "allow", re: patternToRegExp(val), len: val.length });
    else if (key === "crawl-delay") {
      const n = Number(val);
      if (Number.isFinite(n) && n >= 0) cur.delay = n;
    }
  }
  const named = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const chosen = named.length ? named : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);
  const delay = chosen.map((g) => g.delay).find((d) => d !== null) ?? 0;
  return {
    crawlDelayMs: Math.min(delay, MAX_ROBOTS_DELAY_S) * 1000,
    allows(path) {
      let best: { allow: boolean; len: number } | null = null;
      for (const r of rules) if (r.re.test(path) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
      return best ? best.allow : true;
    },
  };
}

// ---------------------------------------------------------------------------------------------- host rules
const stripWww = (h: string) => h.toLowerCase().replace(/^www\./, "");
/** Same site = same host (`www.` ignored) and port; with subdomains also any host below the root host. */
export function hostAllowed(root: URL, candidate: URL, includeSubdomains: boolean): boolean {
  const a = stripWww(root.hostname);
  const b = stripWww(candidate.hostname);
  if (root.port !== candidate.port && (root.port || candidate.port)) {
    const dflt = (u: URL) => (u.port ? u.port : u.protocol === "https:" ? "443" : "80");
    if (dflt(root) !== dflt(candidate)) return false;
  }
  return b === a || (includeSubdomains && b.endsWith(`.${a}`));
}
/** Dedupe key: normalized URL with `www.` ignored, so `/a` and `/a/` and `www.x/a` are the same page. */
export const crawlKey = (url: string): string => url.replace(/^(https?:\/\/)www\./i, "$1");

// ---------------------------------------------------------------------------------------------- the crawl
export interface CrawlDeps {
  resolver?: Resolver;
  fetchImpl?: typeof fetch;
  /** gap between requests; default 500 ms. Tests pass 0. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  budgetMs?: number;
  onProgress?: (p: CrawlProgress) => Promise<void> | void;
}

export async function crawl(rootUrl: string, rawCfg: Partial<CrawlConfig>, deps: CrawlDeps = {}): Promise<{ pages: CrawledPage[]; progress: CrawlProgress }> {
  const cfg = resolveCrawlConfig(rawCfg);
  const limit = cfg.followLinks ? cfg.maxPages : 1;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const baseDelay = deps.delayMs ?? CRAWL_DELAY_MS;
  const started = now();
  const budget = deps.budgetMs ?? CRAWL_BUDGET_MS;

  const rootNorm = normalizeUrl(rootUrl) ?? rootUrl;
  const queue: { url: string; depth: number }[] = [{ url: rootNorm, depth: 0 }];
  const seen = new Set<string>([crawlKey(rootNorm)]);
  const discoveryCap = limit * 10;
  const pages: CrawledPage[] = [];
  const robots = new Map<string, Promise<RobotsRules>>();
  let root = new URL(rootNorm);
  let total = 0;
  let skipped = 0;
  let lastFetch = 0;
  let extraDelay = 0;
  let truncated = false;
  let first = true;

  const polite = async () => {
    const wait = lastFetch + Math.max(baseDelay, extraDelay) - now();
    if (lastFetch && wait > 0) await sleep(wait);
    lastFetch = now();
  };
  const fetchOpts = { timeoutMs: 15_000, resolver: deps.resolver, fetchImpl: deps.fetchImpl, headers: { "user-agent": CRAWL_USER_AGENT } };
  /** robots.txt is fetched once per origin through safeFetch; anything but a clean 200 means "no rules". */
  const rulesFor = (u: URL): Promise<RobotsRules> => {
    let p = robots.get(u.origin);
    if (!p) {
      p = (async () => {
        try {
          await polite();
          const res = await safeFetch(`${u.origin}/robots.txt`, { ...fetchOpts, timeoutMs: 10_000, maxBytes: 512 * 1024, headers: { ...fetchOpts.headers, accept: "text/plain,*/*" } });
          if (res.status !== 200 || res.contentType.toLowerCase().includes("html")) return ALLOW_ALL;
          return parseRobots(new TextDecoder().decode(res.body));
        } catch {
          return ALLOW_ALL;
        }
      })();
      robots.set(u.origin, p);
    }
    return p;
  };
  const report = (done: boolean) => {
    const p: CrawlProgress = { pagesCrawled: pages.length, pagesFound: seen.size, pagesSkipped: skipped, done, ...(truncated ? { truncated } : {}) };
    return p;
  };

  while (queue.length && pages.length < limit && total < MAX_TEXT_CHARS) {
    if (now() - started > budget) {
      truncated = true;
      break;
    }
    const { url, depth } = queue.shift()!;
    const isRoot = first;
    first = false;
    const target = new URL(url);
    const rules = await rulesFor(target);
    extraDelay = Math.max(extraDelay, rules.crawlDelayMs);
    if (!rules.allows(target.pathname + target.search)) {
      if (isRoot) throw new CrawlBlockedError("robots.txt does not allow reading this page");
      skipped++;
      await deps.onProgress?.(report(false));
      continue;
    }
    let res;
    try {
      await polite();
      res = await safeFetch(url, { ...fetchOpts, maxBytes: 2 * 1024 * 1024, headers: { ...fetchOpts.headers, accept: "text/html,application/xhtml+xml,text/plain,application/pdf;q=0.8,*/*;q=0.1" } });
    } catch (e) {
      if (isRoot) throw e; // the first page must work; later pages are best-effort
      skipped++;
      continue;
    }
    if (res.status >= 400) {
      if (isRoot) throw new Error(`source returned HTTP ${res.status}`);
      skipped++;
      continue;
    }
    const final = new URL(res.url);
    if (isRoot) root = final;
    else if (!hostAllowed(root, final, cfg.includeSubdomains)) {
      skipped++; // a redirect left the site
      continue;
    }
    const finalNorm = normalizeUrl(res.url) ?? res.url;
    if (crawlKey(finalNorm) !== crawlKey(url)) {
      const k = crawlKey(finalNorm);
      if (seen.has(k) && !isRoot) {
        skipped++; // a redirect landed on a page we already know
        continue;
      }
      seen.add(k);
    }
    const ct = res.contentType.toLowerCase();
    let text: string;
    let title: string | undefined;
    let html: string | null = null;
    if (ct.includes("html") || ct === "") {
      html = new TextDecoder().decode(res.body);
      const t = htmlToText(html);
      text = t.text;
      title = t.title ? normalizeInline(t.title) : undefined;
    } else if (ct.includes("pdf")) {
      text = await extractFromFile("page.pdf", res.body);
    } else if (ct.startsWith("text/")) {
      text = normalizeWs(new TextDecoder().decode(res.body));
    } else {
      if (isRoot) throw new UnsupportedFileError(`unsupported content type ${ct}`);
      skipped++; // images, JSON, archives and other non-text types are skipped
      continue;
    }
    if (text) {
      pages.push({ text, metadata: { url: finalNorm, ...(title ? { title } : {}), depth } });
      total += text.length;
    } else skipped++;
    if (html && cfg.followLinks && depth < cfg.maxDepth) {
      for (const l of extractLinks(html, final, (u) => hostAllowed(root, u, cfg.includeSubdomains))) {
        const k = crawlKey(l);
        if (seen.has(k) || seen.size >= discoveryCap) continue;
        seen.add(k);
        queue.push({ url: l, depth: depth + 1 });
      }
    }
    await deps.onProgress?.(report(false));
  }
  const progress = report(true);
  await deps.onProgress?.(progress);
  return { pages, progress };
}
