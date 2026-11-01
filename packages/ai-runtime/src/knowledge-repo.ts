import { TenantRepository, type Tx } from "@yulona/db";
import type { CrawlConfig, CrawlProgress } from "./crawl";
import { slugify } from "./sections";

export type SourceStatus = "pending" | "processing" | "ready" | "failed";
export interface SourceRow {
  id: string;
  tenantId: string;
  agentId: string | null;
  type: "file" | "url" | "text";
  name: string;
  /** folder-like id the agent uses to open this skill */
  slug: string;
  description: string | null;
  status: SourceStatus;
  error: string | null;
  sourceUrl: string | null;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number;
  crawlConfig: Partial<CrawlConfig> & { progress?: CrawlProgress };
  attempts: number;
  chunkCount: number;
  lastIngestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
const COLS = `id, tenant_id, agent_id, type, name, slug, description, status, error, source_url, file_name, mime_type, size_bytes,
  crawl_config, attempts, chunk_count, last_ingested_at, created_at, updated_at`;

export class KnowledgeRepository extends TenantRepository {
  async list(f: { agentId?: string; status?: string; limit: number; offset: number }): Promise<SourceRow[]> {
    return this.tx<SourceRow[]>`
      SELECT ${this.tx.unsafe(COLS)} FROM knowledge_sources
      WHERE tenant_id = ${this.tenantId}
        ${f.agentId ? this.tx`AND agent_id = ${f.agentId}` : this.tx``}
        ${f.status ? this.tx`AND status = ${f.status}` : this.tx``}
      ORDER BY created_at DESC LIMIT ${f.limit} OFFSET ${f.offset}`;
  }
  async get(id: string): Promise<SourceRow | undefined> {
    const [r] = await this.tx<SourceRow[]>`SELECT ${this.tx.unsafe(COLS)} FROM knowledge_sources WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
    return r;
  }
  async create(i: {
    type: "file" | "url" | "text"; name: string; agentId?: string | null; sourceUrl?: string; fileName?: string; mimeType?: string;
    sizeBytes?: number; rawText?: string; crawlConfig?: object; createdBy?: string | null; description?: string;
  }): Promise<SourceRow> {
    const slug = await this.uniqueSlug(slugify(i.name));
    const [r] = await this.tx<SourceRow[]>`
      INSERT INTO knowledge_sources (tenant_id, agent_id, type, name, slug, description, source_url, file_name, mime_type, size_bytes, raw_text, crawl_config, created_by)
      VALUES (${this.tenantId}, ${i.agentId ?? null}, ${i.type}, ${i.name}, ${slug}, ${i.description ?? null}, ${i.sourceUrl ?? null}, ${i.fileName ?? null}, ${i.mimeType ?? null},
              ${i.sizeBytes ?? 0}, ${i.rawText ?? null}, ${JSON.stringify(i.crawlConfig ?? {})}::text::jsonb, ${i.createdBy ?? null})
      RETURNING ${this.tx.unsafe(COLS)}`;
    return r!;
  }
  private async uniqueSlug(base: string): Promise<string> {
    const taken = new Set((await this.tx<{ slug: string }[]>`SELECT slug FROM knowledge_sources WHERE tenant_id = ${this.tenantId} AND slug LIKE ${base + "%"}`).map((r) => r.slug));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  }
  /** Operator edits: the name and the one-line description the agent sees in its skill index. */
  async update(id: string, p: { name?: string; description?: string | null }): Promise<SourceRow | undefined> {
    const [r] = await this.tx<SourceRow[]>`
      UPDATE knowledge_sources SET name = COALESCE(${p.name ?? null}, name),
        description = CASE WHEN ${p.description === undefined} THEN description ELSE ${p.description ?? null} END, updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND id = ${id} RETURNING ${this.tx.unsafe(COLS)}`;
    return r;
  }
  async putBlob(sourceId: string, data: Uint8Array): Promise<void> {
    await this.tx`
      INSERT INTO knowledge_source_blobs (tenant_id, source_id, data) VALUES (${this.tenantId}, ${sourceId}, ${data as Buffer})
      ON CONFLICT (tenant_id, source_id) DO UPDATE SET data = EXCLUDED.data`;
  }
  async getBlob(sourceId: string): Promise<Uint8Array | null> {
    const [r] = await this.tx<{ data: Uint8Array }[]>`SELECT data FROM knowledge_source_blobs WHERE tenant_id = ${this.tenantId} AND source_id = ${sourceId}`;
    return r?.data ?? null;
  }
  async getRawText(sourceId: string): Promise<string | null> {
    const [r] = await this.tx<{ rawText: string | null }[]>`SELECT raw_text FROM knowledge_sources WHERE tenant_id = ${this.tenantId} AND id = ${sourceId}`;
    return r?.rawText ?? null;
  }
  /** pending|failed -> processing (or stale processing). Returns false if someone else holds it / it is ready. */
  async claim(id: string): Promise<boolean> {
    const rows = await this.tx`
      UPDATE knowledge_sources SET status = 'processing', error = NULL, attempts = attempts + 1, updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND id = ${id}
        AND (status IN ('pending','failed') OR (status = 'processing' AND updated_at < now() - interval '10 minutes'))
      RETURNING id`;
    return rows.length > 0;
  }
  async markFailed(id: string, error: string): Promise<void> {
    await this.tx`UPDATE knowledge_sources SET status = 'failed', error = ${error.slice(0, 500)}, updated_at = now() WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
  }
  /** Crawl progress for the UI. Also a heartbeat: it bumps `updated_at` so a long crawl is not reclaimed as stale. */
  async setCrawlProgress(id: string, progress: CrawlProgress | null): Promise<void> {
    await this.tx`
      UPDATE knowledge_sources SET updated_at = now(),
        crawl_config = CASE WHEN ${progress === null} THEN crawl_config - 'progress'
                            ELSE jsonb_set(crawl_config, '{progress}', ${JSON.stringify(progress)}::text::jsonb) END
      WHERE tenant_id = ${this.tenantId} AND id = ${id}`;
  }
  async requeue(id: string): Promise<boolean> {
    const rows = await this.tx`
      UPDATE knowledge_sources SET status = 'pending', error = NULL, updated_at = now()
      WHERE tenant_id = ${this.tenantId} AND id = ${id} AND status IN ('ready','failed') RETURNING id`;
    return rows.length > 0;
  }
  /** Replace all sections of a skill and mark it ready (single transaction => never half-indexed). */
  async replaceSections(sourceId: string, agentId: string | null, sections: { index: number; title: string; content: string; metadata?: object }[], autoDescription?: string): Promise<void> {
    await this.tx`DELETE FROM knowledge_chunks WHERE tenant_id = ${this.tenantId} AND source_id = ${sourceId}`;
    for (const c of sections) {
      await this.tx`
        INSERT INTO knowledge_chunks (tenant_id, source_id, agent_id, chunk_index, title, content, token_count, metadata)
        VALUES (${this.tenantId}, ${sourceId}, ${agentId}, ${c.index}, ${c.title}, ${c.content}, ${Math.ceil(c.content.length / 4)}, ${JSON.stringify(c.metadata ?? {})}::text::jsonb)`;
    }
    await this.tx`
      UPDATE knowledge_sources SET status = 'ready', error = NULL, chunk_count = ${sections.length}, last_ingested_at = now(), updated_at = now(),
        description = COALESCE(description, ${autoDescription ?? null})
      WHERE tenant_id = ${this.tenantId} AND id = ${sourceId}`;
    await this.tx`DELETE FROM knowledge_source_blobs WHERE tenant_id = ${this.tenantId} AND source_id = ${sourceId}`;
  }
  /** Cascade removes chunks + blob (FK ON DELETE CASCADE). */
  async delete(id: string): Promise<boolean> {
    const rows = await this.tx`DELETE FROM knowledge_sources WHERE tenant_id = ${this.tenantId} AND id = ${id} RETURNING id`;
    return rows.length > 0;
  }
  async listChunks(sourceId: string, limit: number, offset: number) {
    return this.tx<{ id: string; chunkIndex: number; title: string; content: string; tokenCount: number; url: string | null }[]>`
      SELECT id, chunk_index, title, content, token_count, metadata->>'url' AS url FROM knowledge_chunks
      WHERE tenant_id = ${this.tenantId} AND source_id = ${sourceId} ORDER BY chunk_index LIMIT ${limit} OFFSET ${offset}`;
  }
}

export type { Tx };
