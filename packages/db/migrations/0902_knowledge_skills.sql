-- Knowledge is organised as "skills" (one per source) made of titled sections and found by keyword search and by the
-- agent reading them, not by embeddings. Existing chunks stay valid as sections (they only lose their vectors).
-- (Replaces the unreleased 0901 draft; the full-text column below includes the section title.)
DROP INDEX IF EXISTS knowledge_chunks_embedding_hnsw;
DROP INDEX IF EXISTS knowledge_chunks_tsv_idx;
ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS embedding;
ALTER TABLE knowledge_chunks DROP COLUMN IF EXISTS content_tsv;
ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT '';
ALTER TABLE knowledge_chunks ADD COLUMN content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || content)) STORED;
CREATE INDEX knowledge_chunks_tsv_idx ON knowledge_chunks USING gin (content_tsv);

ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE knowledge_sources ADD COLUMN IF NOT EXISTS description text CHECK (description IS NULL OR char_length(description) <= 500);
UPDATE knowledge_sources s SET slug = x.slug
FROM (
  SELECT id,
         CASE WHEN row_number() OVER (PARTITION BY tenant_id, base ORDER BY created_at, id) = 1 THEN base
              ELSE base || '-' || row_number() OVER (PARTITION BY tenant_id, base ORDER BY created_at, id) END AS slug
  FROM (SELECT id, tenant_id, created_at,
               COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'skill') AS base
        FROM knowledge_sources) b
) x
WHERE s.id = x.id AND s.slug IS NULL;
ALTER TABLE knowledge_sources ALTER COLUMN slug SET NOT NULL;
-- Rows created without a slug (direct SQL, imports) get one derived from the name.
CREATE OR REPLACE FUNCTION knowledge_sources_default_slug() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE base text; cand text; n int := 1;
BEGIN
  IF NEW.slug IS NOT NULL THEN RETURN NEW; END IF;
  base := COALESCE(NULLIF(trim(both '-' from lower(regexp_replace(NEW.name, '[^a-zA-Z0-9]+', '-', 'g'))), ''), 'skill');
  cand := base;
  WHILE EXISTS (SELECT 1 FROM knowledge_sources WHERE tenant_id = NEW.tenant_id AND slug = cand) LOOP
    n := n + 1;
    cand := base || '-' || n;
  END LOOP;
  NEW.slug := cand;
  RETURN NEW;
END $$;
CREATE TRIGGER knowledge_sources_default_slug BEFORE INSERT ON knowledge_sources FOR EACH ROW EXECUTE FUNCTION knowledge_sources_default_slug();
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_sources_tenant_slug_idx ON knowledge_sources (tenant_id, slug);
