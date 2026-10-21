-- ai-runtime (migration range 0200-0299): knowledge base, stage state, tool + handoff logs, AI usage.
-- No FK to agents/conversations on purpose: those tables are created by other migration ranges
-- (0100s / 0300s). Tenant isolation is still enforced by tenant_id FK + RLS on every table.

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  agent_id       uuid,
  type           text NOT NULL CHECK (type IN ('file','url','text')),
  name           text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','failed')),
  error          text,
  source_url     text,
  file_name      text,
  mime_type      text,
  size_bytes     bigint NOT NULL DEFAULT 0,
  raw_text       text,
  crawl_config   jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts       integer NOT NULL DEFAULT 0,
  chunk_count    integer NOT NULL DEFAULT 0,
  last_ingested_at timestamptz,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS knowledge_sources_tenant_created_idx ON knowledge_sources (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS knowledge_sources_tenant_agent_idx ON knowledge_sources (tenant_id, agent_id);

-- Uploaded file bytes live here only until ingestion succeeds (then deleted).
CREATE TABLE IF NOT EXISTS knowledge_source_blobs (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  source_id uuid NOT NULL,
  data      bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source_id),
  FOREIGN KEY (tenant_id, source_id) REFERENCES knowledge_sources (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  source_id   uuid NOT NULL,
  agent_id    uuid,
  chunk_index integer NOT NULL,
  content     text NOT NULL,
  token_count integer NOT NULL,
  embedding   vector(1536) NOT NULL,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, source_id) REFERENCES knowledge_sources (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_tenant_source_idx ON knowledge_chunks (tenant_id, source_id, chunk_index);
CREATE INDEX IF NOT EXISTS knowledge_chunks_tenant_agent_idx ON knowledge_chunks (tenant_id, agent_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_hnsw ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS conversation_ai_state (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL,
  stage           text NOT NULL DEFAULT 'visitor'
                  CHECK (stage IN ('visitor','engaged','qualified','booking_offered','booked','handoff_requested')),
  lead            jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_paused       boolean NOT NULL DEFAULT false,
  last_handoff_type text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS stage_transitions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL,
  from_stage      text NOT NULL,
  to_stage        text NOT NULL,
  reason          text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stage_transitions_conv_idx ON stage_transitions (tenant_id, conversation_id, created_at);
CREATE INDEX IF NOT EXISTS stage_transitions_funnel_idx ON stage_transitions (tenant_id, to_stage, created_at);

CREATE TABLE IF NOT EXISTS tool_executions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid,
  tool_name       text NOT NULL,
  input           jsonb NOT NULL DEFAULT '{}'::jsonb,
  output          jsonb,
  success         boolean NOT NULL,
  error           text,
  latency_ms      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tool_executions_conv_idx ON tool_executions (tenant_id, conversation_id, created_at);

CREATE TABLE IF NOT EXISTS handoffs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  conversation_id uuid NOT NULL,
  type            text NOT NULL CHECK (type IN ('uncertainty','stage','system_failure')),
  reason          text NOT NULL,
  summary         text,
  lead_card       jsonb,
  context         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);
CREATE INDEX IF NOT EXISTS handoffs_tenant_created_idx ON handoffs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS handoffs_conv_idx ON handoffs (tenant_id, conversation_id);

CREATE TABLE IF NOT EXISTS ai_usage (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  day       date NOT NULL,
  kind      text NOT NULL CHECK (kind IN ('llm_prompt_tokens','llm_completion_tokens','embedding_tokens','llm_requests')),
  amount    bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day, kind)
);

-- ---- RLS (ENABLE + FORCE, same pattern as 0001) ---------------------------------------------------
DO $$
DECLARE t text; owner_role text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['knowledge_sources','knowledge_source_blobs','knowledge_chunks','conversation_ai_state',
                           'stage_transitions','tool_executions','handoffs','ai_usage'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'owner_all') THEN
      EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, owner_role);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO yulona_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    END IF;
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_sources, knowledge_source_blobs, knowledge_chunks TO yulona_app;
GRANT SELECT, INSERT, UPDATE ON conversation_ai_state, handoffs, ai_usage TO yulona_app;
GRANT SELECT, INSERT ON stage_transitions, tool_executions TO yulona_app;
