-- Agent builder chat (migration range 0930-0939): AI-assisted agent drafting sessions.
-- A session belongs to one user of one tenant; messages are persisted for audit and reload.
CREATE TABLE builder_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','created','abandoned')),
  draft       jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_id    uuid,
  tokens_used integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX builder_sessions_tenant_user_idx ON builder_sessions (tenant_id, user_id, created_at DESC);

CREATE TABLE builder_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  session_id  uuid NOT NULL,
  role        text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content     text NOT NULL DEFAULT '' CHECK (char_length(content) <= 20000),
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, session_id) REFERENCES builder_sessions (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX builder_messages_session_idx ON builder_messages (tenant_id, session_id, created_at);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['builder_sessions','builder_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, current_user);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO yulona_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO yulona_app', t);
  END LOOP;
END $$;

ALTER TABLE agents ADD COLUMN IF NOT EXISTS created_via text CHECK (created_via IS NULL OR created_via IN ('builder'));
