-- Files the platform stores for a tenant (GDPR export archives) when no S3/MinIO bucket is configured.
-- Keys start with "<area>/<tenant id>/", so every access runs inside that tenant's row-level security.
CREATE TABLE object_store (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key          text NOT NULL,
  content_type text,
  data         bytea NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

DO $$
DECLARE t text; owner_role text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['object_store'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, owner_role);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO yulona_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON object_store TO yulona_app;
