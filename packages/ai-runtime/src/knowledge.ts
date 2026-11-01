import { withTenant, type Db } from "@yulona/db";
import { turnLimits } from "./limits";

/**
 * Agent knowledge as "skills": every ready source is a skill folder (slug, name, description) of titled sections.
 * The agent sees the index, gets the best-matching sections pre-loaded by keyword search, and can open more with the
 * `search_skills` / `read_skill` tools, much like a coding agent exploring a directory. No embeddings anywhere.
 */
export interface SkillSummary {
  sourceId: string;
  slug: string;
  name: string;
  description: string;
  sections: number;
  chars: number;
}
export interface SkillSection {
  id: string;
  sourceId: string;
  skill: string;
  skillName: string;
  section: number;
  title: string;
  content: string;
  /** 0..1 keyword rank (1 for sections loaded wholesale) */
  score: number;
}
export interface KnowledgePort {
  index(): Promise<SkillSummary[]>;
  /** every section, in order, up to `maxChars` (used when the whole knowledge base is small) */
  all(maxChars: number): Promise<SkillSection[]>;
  search(query: string, o?: { skill?: string; limit?: number }): Promise<SkillSection[]>;
  /** one section, or (no `section`) the whole skill if short, else its outline */
  read(skill: string, section?: number): Promise<{ skill: SkillSummary; sections: SkillSection[]; outline?: { section: number; title: string; chars: number }[] } | null>;
}

const STOP = new Set(["the", "and", "for", "are", "you", "your", "with", "what", "how", "can", "does", "did", "this", "that", "have", "has", "from", "about", "please", "tell", "any", "our", "who", "when", "where", "why", "which", "there", "their", "them", "its", "was", "were", "will", "would", "could", "should", "get", "got", "not", "but", "yes", "hello", "thanks", "thank", "much", "many", "some", "need", "want", "like", "know"]);

/** Crude suffix stripping so "prices", "pricing" and "price" meet at "pric" (used as a prefix match). */
const stem = (w: string): string => {
  const s = w.replace(/(ing|ed|es|s|e)$/u, "");
  return s.length >= 4 ? s : w;
};

/** Distinct meaningful, stemmed terms of a message; letters/digits only, so they are safe inside a tsquery. */
export function queryTerms(text: string, max = 12): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length < 3 || STOP.has(w)) continue;
    const t = stem(w);
    if (!out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

type Row = { id: string; sourceId: string; slug: string; name: string; chunkIndex: number; title: string; content: string; rank?: number };
const toSection = (r: Row, score: number): SkillSection => ({
  id: r.id, sourceId: r.sourceId, skill: r.slug, skillName: r.name, section: r.chunkIndex, title: r.title || `Section ${r.chunkIndex + 1}`, content: r.content, score,
});

export function createKnowledgePort(db: Db, tenantId: string, agentId: string | null): KnowledgePort {
  const readCap = turnLimits().readCapChars;
  const scope = (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) =>
    tx`s.tenant_id = ${tenantId} AND s.status = 'ready' AND (s.agent_id IS NULL OR s.agent_id = ${agentId})`;
  const run = <T>(fn: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) => withTenant(db, tenantId, fn);

  const index = (): Promise<SkillSummary[]> =>
    run(async (tx) =>
      (await tx<{ sourceId: string; slug: string; name: string; description: string | null; sections: number; chars: number }[]>`
        SELECT s.id AS source_id, s.slug, s.name, s.description, count(c.id)::int AS sections, COALESCE(sum(length(c.content)), 0)::int AS chars
        FROM knowledge_sources s LEFT JOIN knowledge_chunks c ON c.tenant_id = s.tenant_id AND c.source_id = s.id
        WHERE ${scope(tx)}
        GROUP BY s.id ORDER BY s.created_at, s.id LIMIT 60`).map((r) => ({ ...r, description: r.description ?? r.name })));

  return {
    index,
    all: (maxChars) =>
      run(async (tx) => {
        const rows = await tx<Row[]>`
          SELECT c.id, c.source_id, s.slug, s.name, c.chunk_index, c.title, c.content
          FROM knowledge_chunks c JOIN knowledge_sources s ON s.tenant_id = c.tenant_id AND s.id = c.source_id
          WHERE ${scope(tx)} ORDER BY s.created_at, s.id, c.chunk_index LIMIT 400`;
        const out: SkillSection[] = [];
        let used = 0;
        for (const r of rows) {
          if (used + r.content.length > maxChars) break;
          used += r.content.length;
          out.push(toSection(r, 1));
        }
        return out;
      }),
    search: (query, o = {}) =>
      run(async (tx) => {
        const terms = queryTerms(query);
        if (!terms.length) return [];
        const q = terms.map((t) => `${t}:*`).join(" | ");
        const limit = Math.min(Math.max(o.limit ?? 4, 1), 12);
        const rows = await tx<Row[]>`
          SELECT c.id, c.source_id, s.slug, s.name, c.chunk_index, c.title, c.content,
                 ts_rank_cd(c.content_tsv, to_tsquery('simple', ${q}), 32) AS rank
          FROM knowledge_chunks c JOIN knowledge_sources s ON s.tenant_id = c.tenant_id AND s.id = c.source_id
          WHERE ${scope(tx)} AND c.content_tsv @@ to_tsquery('simple', ${q})
            ${o.skill ? tx`AND (s.slug = ${o.skill} OR lower(s.name) = ${o.skill.toLowerCase()})` : tx``}
          ORDER BY rank DESC, s.created_at, c.chunk_index LIMIT ${limit}`;
        // Prefer sections that contain more of the distinct terms (rank alone favours repetition).
        const hits = rows.map((r) => {
          const lc = `${r.title} ${r.content}`.toLowerCase();
          return { r, covered: terms.filter((t) => lc.includes(t)).length / terms.length };
        });
        hits.sort((a, b) => b.covered - a.covered || Number(b.r.rank) - Number(a.r.rank));
        return hits.map(({ r, covered }) => toSection(r, Number(Math.min(1, 0.5 * covered + 0.5 * Number(r.rank ?? 0)).toFixed(3))));
      }),
    read: (skill, section) =>
      run(async (tx) => {
        const key = skill.trim();
        const [src] = await tx<{ sourceId: string; slug: string; name: string; description: string | null }[]>`
          SELECT s.id AS source_id, s.slug, s.name, s.description FROM knowledge_sources s
          WHERE ${scope(tx)} AND (s.slug = ${key} OR lower(s.name) = ${key.toLowerCase()}) LIMIT 1`;
        if (!src) return null;
        const rows = await tx<Row[]>`
          SELECT c.id, c.source_id, ${src.slug}::text AS slug, ${src.name}::text AS name, c.chunk_index, c.title, c.content
          FROM knowledge_chunks c WHERE c.tenant_id = ${tenantId} AND c.source_id = ${src.sourceId} ORDER BY c.chunk_index`;
        const summary: SkillSummary = {
          sourceId: src.sourceId, slug: src.slug, name: src.name, description: src.description ?? src.name,
          sections: rows.length, chars: rows.reduce((a, r) => a + r.content.length, 0),
        };
        if (section !== undefined) return { skill: summary, sections: rows.filter((r) => r.chunkIndex === section).map((r) => toSection(r, 1)) };
        if (summary.chars <= readCap) return { skill: summary, sections: rows.map((r) => toSection(r, 1)) };
        return { skill: summary, sections: [], outline: rows.map((r) => ({ section: r.chunkIndex, title: r.title || `Section ${r.chunkIndex + 1}`, chars: r.content.length })) };
      }),
  };
}
