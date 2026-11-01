-- Wave 7 / K (migration range 1020-1049): workspace goals + onboarding state, copilot sessions, copilot allowance.

-- ---- goals and onboarding state on the tenant -------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN goals text[] NOT NULL DEFAULT '{}'
  CHECK (goals <@ ARRAY['support','leads','bookings','other']::text[] AND cardinality(goals) <= 4);
ALTER TABLE tenants ADD COLUMN onboarding jsonb NOT NULL DEFAULT '{}'::jsonb;
GRANT UPDATE (goals, onboarding) ON tenants TO yulona_app;

-- ---- usage sources and the separate copilot allowance -----------------------------------------------------
ALTER TABLE ai_usage_events DROP CONSTRAINT ai_usage_events_source_check;
ALTER TABLE ai_usage_events ADD CONSTRAINT ai_usage_events_source_check
  CHECK (source IN ('turn','sandbox','builder','tool_test','copilot','onboarding'));

ALTER TABLE plan_limits DROP CONSTRAINT plan_limits_metric_check;
ALTER TABLE plan_limits ADD CONSTRAINT plan_limits_metric_check
  CHECK (metric IN ('seats','agents','widgets','api_keys','monthly_conversations','storage_mb','llm_tokens_monthly','llm_credits_monthly','copilot_credits_monthly'));
-- Placeholders, editable by the platform admin (null = unlimited).
INSERT INTO plan_limits (plan_key, metric, limit_value) VALUES
  ('free','copilot_credits_monthly',0), ('pro','copilot_credits_monthly',150),
  ('enterprise','copilot_credits_monthly',600), ('self_hosted','copilot_credits_monthly',NULL)
ON CONFLICT (plan_key, metric) DO NOTHING;

-- ---- copilot ("Ask Lumi") ------------------------------------------------------------------------------------
CREATE TABLE copilot_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  user_id     uuid NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  tokens_used integer NOT NULL DEFAULT 0,
  -- DB-backed in-flight guard: set while a turn is being answered, cleared at the end (expires on its own if the process dies)
  busy_until  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX copilot_sessions_user_idx ON copilot_sessions (tenant_id, user_id, created_at DESC);

CREATE TABLE copilot_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  session_id  uuid NOT NULL,
  role        text NOT NULL CHECK (role IN ('user','assistant','tool')),
  content     text NOT NULL DEFAULT '' CHECK (char_length(content) <= 20000),
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, session_id) REFERENCES copilot_sessions (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX copilot_messages_session_idx ON copilot_messages (tenant_id, session_id, created_at);
CREATE INDEX copilot_messages_month_idx ON copilot_messages (tenant_id, created_at) WHERE role = 'user';

-- High-impact actions the model may only PROPOSE. The token (shown to the user in the UI, never to the model) is stored hashed.
CREATE TABLE copilot_pending_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  session_id  uuid NOT NULL,
  user_id     uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('publish_agent')),
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_hash  text NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled')),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  FOREIGN KEY (tenant_id, session_id) REFERENCES copilot_sessions (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX copilot_pending_session_idx ON copilot_pending_actions (tenant_id, session_id, created_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['copilot_sessions','copilot_messages','copilot_pending_actions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, current_user);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO yulona_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO yulona_app', t);
  END LOOP;
END $$;
