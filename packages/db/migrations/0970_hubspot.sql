-- Wave 5 D: native HubSpot CRM integration (migration range 0970-0979).
-- crm_connections: one row per tenant and provider. The private-app access token is AES-256-GCM sealed with ENCRYPTION_KEY
-- (AAD `crm:{tenant}:hubspot`) and is write-only via the API. settings holds the property mapping (see packages/shared/src/hubspot.ts).
CREATE TABLE crm_connections (
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  provider        text NOT NULL CHECK (provider IN ('hubspot')),
  token_encrypted text NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','error')),
  last_error      text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at    timestamptz,
  connected_by    uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider),
  FOREIGN KEY (tenant_id, connected_by) REFERENCES users (tenant_id, id)
);

ALTER TABLE contacts ADD COLUMN hubspot_id text CHECK (hubspot_id IS NULL OR char_length(hubspot_id) <= 64);

-- One row per (conversation, trigger): the idempotency key of the sync and the visible sync history.
CREATE TABLE crm_sync_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  provider        text NOT NULL DEFAULT 'hubspot' CHECK (provider IN ('hubspot')),
  conversation_id uuid,
  contact_id      uuid,
  trigger         text NOT NULL CHECK (trigger IN ('qualified','booked','test')),
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','failed','skipped')),
  action          text CHECK (action IS NULL OR action IN ('created','updated')),
  hubspot_id      text,
  attempts        integer NOT NULL DEFAULT 0,
  error           text CHECK (error IS NULL OR char_length(error) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  synced_at       timestamptz,
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX crm_sync_log_conv_trigger_uniq ON crm_sync_log (tenant_id, provider, conversation_id, trigger) WHERE conversation_id IS NOT NULL;
CREATE INDEX crm_sync_log_tenant_idx ON crm_sync_log (tenant_id, created_at DESC);

DO $$
DECLARE t text; owner_role text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['crm_connections','crm_sync_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, owner_role);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO yulona_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_connections TO yulona_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON crm_sync_log TO yulona_app;
