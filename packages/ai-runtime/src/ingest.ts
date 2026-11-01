import { withTenant, type Db } from "@yulona/db";
import { CrawlBlockedError, crawl, type CrawlConfig } from "./crawl";
import { UnsupportedFileError, extractFromFile, normalizeInline, normalizeWs } from "./extract";
import { VirusFoundError } from "./clamav";
import { KnowledgeRepository, type SourceRow } from "./knowledge-repo";
import { describeSkill, sectionize } from "./sections";
import { SsrfError, type Resolver } from "./ssrf";

export interface IngestDeps {
  db: Db;
  resolver?: Resolver;
  fetchImpl?: typeof fetch;
  /** Crawl pacing/budget overrides (tests); production uses the defaults (500 ms between requests). */
  crawlDelayMs?: number;
  crawlSleep?: (ms: number) => Promise<void>;
  crawlBudgetMs?: number;
}
export interface IngestPayload {
  tenantId: string;
  sourceId: string;
}

/** Errors that will never succeed on retry: record `failed` and do NOT rethrow. */
function isPermanent(e: unknown): boolean {
  return e instanceof UnsupportedFileError || e instanceof SsrfError || e instanceof CrawlBlockedError || e instanceof VirusFoundError || (e instanceof Error && e.message === "no_extractable_text");
}

type Page = { text: string; metadata: Record<string, unknown> };

/** Job `knowledge.ingest`: extract -> split into titled sections -> store (no AI calls); status machine pending->processing->ready|failed. */
export async function ingestSource(deps: IngestDeps, p: IngestPayload): Promise<"ready" | "skipped" | "failed"> {
  const { db } = deps;
  const loaded = await withTenant(db, p.tenantId, async (tx) => {
    const repo = new KnowledgeRepository(tx, p.tenantId);
    const src = await repo.get(p.sourceId);
    if (!src) return null;
    if (!(await repo.claim(p.sourceId))) return null;
    const blob = src.type === "file" ? await repo.getBlob(p.sourceId) : null;
    const raw = src.type === "text" ? await repo.getRawText(p.sourceId) : null;
    return { src, blob, raw };
  });
  if (!loaded) return "skipped";
  const { src, blob, raw } = loaded;

  try {
    let sections: Page[];
    if (src.type === "text") sections = [{ text: normalizeWs(raw ?? ""), metadata: {} }];
    else if (src.type === "file") {
      if (!blob) throw new UnsupportedFileError("uploaded file is no longer available; re-upload it");
      sections = [{ text: await extractFromFile(src.fileName ?? "file.txt", blob), metadata: { file: src.fileName } }];
    } else {
      await withTenant(db, p.tenantId, (tx) => new KnowledgeRepository(tx, p.tenantId).setCrawlProgress(p.sourceId, null));
      const cfg = src.crawlConfig as Partial<CrawlConfig>;
      sections = (await crawl(src.sourceUrl!, cfg, {
        resolver: deps.resolver, fetchImpl: deps.fetchImpl, delayMs: deps.crawlDelayMs, sleep: deps.crawlSleep, budgetMs: deps.crawlBudgetMs,
        onProgress: (pr) => withTenant(db, p.tenantId, (tx) => new KnowledgeRepository(tx, p.tenantId).setCrawlProgress(p.sourceId, pr)),
      })).pages;
    }

    const multi = sections.length > 1;
    const parts = sections.flatMap((pg) => {
      const label = multi && typeof pg.metadata.url === "string" ? new URL(pg.metadata.url).pathname.replace(/\/$/, "") || "/" : undefined;
      return sectionize(pg.text, { fallbackTitle: label ?? "Overview" }).map((sec) => ({
        title: label && !sec.title.startsWith(label) ? `${label} › ${sec.title}` : sec.title,
        content: sec.content,
        metadata: pg.metadata,
      }));
    }).map((c, index) => ({ ...c, index }));
    if (parts.length === 0) throw new Error("no_extractable_text");
    await withTenant(db, p.tenantId, (tx) =>
      new KnowledgeRepository(tx, p.tenantId).replaceSections(p.sourceId, src.agentId, parts, describeSkill(parts, normalizeInline(src.name))));
    return "ready";
  } catch (e) {
    const msg = e instanceof Error && e.message === "no_extractable_text" ? "No text could be extracted from this source" : e instanceof Error ? e.message : "ingestion failed";
    await withTenant(db, p.tenantId, (tx) => new KnowledgeRepository(tx, p.tenantId).markFailed(p.sourceId, msg));
    if (isPermanent(e)) return "failed";
    throw e;
  }
}
