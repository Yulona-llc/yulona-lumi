-- Wave 7 J: uploaded widget avatar (bytes stored per widget, served by the public cacheable avatar route).
-- Only PNG/JPEG/WebP up to 512 KB are accepted by the API (magic-byte checked, antivirus scanned); the CHECKs are a backstop.
CREATE TABLE widget_avatars (
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  widget_id    uuid NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/webp')),
  data         bytea NOT NULL CHECK (octet_length(data) <= 524288),
  etag         text NOT NULL,
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, widget_id),
  FOREIGN KEY (tenant_id, widget_id) REFERENCES widgets (tenant_id, id) ON DELETE CASCADE
);

DO $$
DECLARE t text; owner_role text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['widget_avatars'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, owner_role);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO yulona_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON widget_avatars TO yulona_app;
