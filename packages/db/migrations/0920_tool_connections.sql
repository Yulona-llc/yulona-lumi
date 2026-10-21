-- Tool connections (migration range 0920-0929): per-tenant customer backends that no-code tools call.
-- The credential is AES-256-GCM sealed with ENCRYPTION_KEY (AAD `toolconn:{tenant}:{id}`); it is write-only via the API.
CREATE TABLE tool_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  kind             text NOT NULL DEFAULT 'http' CHECK (kind IN ('http')),
  base_url         text NOT NULL CHECK (char_length(base_url) BETWEEN 8 AND 2000),
  auth_type        text NOT NULL DEFAULT 'none' CHECK (auth_type IN ('none','bearer','api_key','basic','hmac')),
  auth_header_name text CHECK (auth_header_name IS NULL OR auth_header_name ~ '^[A-Za-z0-9-]{1,64}$'),
  test_path        text CHECK (test_path IS NULL OR char_length(test_path) <= 500),
  secret_encrypted text,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, name),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  CHECK ((auth_type = 'none') = (secret_encrypted IS NULL))
);
CREATE INDEX tool_connections_tenant_idx ON tool_connections (tenant_id, created_at);

ALTER TABLE tool_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_connections FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY owner_all ON tool_connections FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
CREATE POLICY tenant_isolation ON tool_connections FOR ALL TO yulona_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON tool_connections TO yulona_app;
