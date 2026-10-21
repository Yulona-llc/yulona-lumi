-- Platform core: plans/limits, usage, feature flags, invitations, agents (+versions), API keys,
-- platform (super) admins, tenant lifecycle. Owner role runs this; app role = yulona_app.

-- ---- plans -------------------------------------------------------------------------------------
CREATE TABLE plans (
  key        text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,31}$'),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE plan_limits (
  plan_key    text NOT NULL REFERENCES plans(key) ON DELETE CASCADE,
  metric      text NOT NULL CHECK (metric IN ('seats','agents','widgets','api_keys','monthly_conversations','storage_mb','llm_tokens_monthly')),
  limit_value bigint CHECK (limit_value IS NULL OR limit_value >= 0), -- NULL = unlimited
  PRIMARY KEY (plan_key, metric)
);
INSERT INTO plans (key, name) VALUES ('free','Free'), ('pro','Pro'), ('enterprise','Enterprise'), ('self_hosted','Self-hosted');
INSERT INTO plan_limits (plan_key, metric, limit_value) VALUES
  ('free','seats',2), ('free','agents',1), ('free','widgets',1), ('free','api_keys',2),
  ('free','monthly_conversations',100), ('free','storage_mb',50), ('free','llm_tokens_monthly',200000),
  ('pro','seats',10), ('pro','agents',5), ('pro','widgets',5), ('pro','api_keys',10),
  ('pro','monthly_conversations',2000), ('pro','storage_mb',2048), ('pro','llm_tokens_monthly',5000000),
  ('enterprise','seats',NULL), ('enterprise','agents',NULL), ('enterprise','widgets',NULL), ('enterprise','api_keys',NULL),
  ('enterprise','monthly_conversations',NULL), ('enterprise','storage_mb',NULL), ('enterprise','llm_tokens_monthly',NULL),
  ('self_hosted','seats',NULL), ('self_hosted','agents',NULL), ('self_hosted','widgets',NULL), ('self_hosted','api_keys',NULL),
  ('self_hosted','monthly_conversations',NULL), ('self_hosted','storage_mb',NULL), ('self_hosted','llm_tokens_monthly',NULL);

ALTER TABLE tenants ADD COLUMN plan_key text NOT NULL DEFAULT 'free' REFERENCES plans(key);
-- Tenants may rename themselves but never change plan/status/deleted_at (super-admin functions do).
REVOKE UPDATE ON tenants FROM yulona_app;
GRANT UPDATE (name, updated_at) ON tenants TO yulona_app;
GRANT SELECT ON plans, plan_limits TO yulona_app;

-- ---- roles: add viewer --------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner','admin','agent','viewer'));

-- ---- feature flags -------------------------------------------------------------------------------
CREATE TABLE feature_flags (
  key             text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  description     text NOT NULL DEFAULT '',
  default_enabled boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON feature_flags TO yulona_app; -- writes only via sa_* functions

CREATE TABLE tenant_flag_overrides (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  flag_key   text NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  enabled    boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, flag_key)
);

-- ---- usage counters (gauges + monthly counters; period = first day of month, or 1970-01-01 for gauges)
CREATE TABLE usage_counters (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  metric     text NOT NULL,
  period     date NOT NULL,
  value      bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric, period)
);

-- ---- invitations ----------------------------------------------------------------------------------
CREATE TABLE invitations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  email       text NOT NULL CHECK (char_length(email) <= 254),
  role        text NOT NULL CHECK (role IN ('owner','admin','agent','viewer')),
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, invited_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX invitations_tenant_idx ON invitations (tenant_id, created_at DESC);
CREATE UNIQUE INDEX invitations_pending_email_uniq ON invitations (tenant_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ---- agents ---------------------------------------------------------------------------------------
CREATE TABLE agents (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description       text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  status            text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  config            jsonb NOT NULL DEFAULT '{}'::jsonb, -- current (draft) config, see @yulona/shared agentConfigSchema
  published_version integer,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX agents_tenant_idx ON agents (tenant_id, created_at DESC);

CREATE TABLE agent_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  agent_id   uuid NOT NULL,
  version    integer NOT NULL CHECK (version >= 1),
  config     jsonb NOT NULL,
  note       text NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, version),
  FOREIGN KEY (tenant_id, agent_id) REFERENCES agents (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX agent_versions_tenant_agent_idx ON agent_versions (tenant_id, agent_id, version DESC);

-- ---- api keys (hash only) -------------------------------------------------------------------------
CREATE TABLE api_keys (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  name                  text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  prefix                text NOT NULL,
  key_hash              text NOT NULL UNIQUE,
  scopes                text[] NOT NULL DEFAULT '{}',
  rate_limit_per_minute integer NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute BETWEEN 1 AND 100000),
  expires_at            timestamptz,
  revoked_at            timestamptz,
  last_used_at          timestamptz,
  created_by            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX api_keys_tenant_idx ON api_keys (tenant_id, created_at DESC);

-- ---- platform (super) admins: NOT tenant users, no tenant_id ---------------------------------------
CREATE TABLE platform_admins (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL CHECK (char_length(email) <= 254),
  name               text NOT NULL,
  password_hash      text NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_admins_email_uniq ON platform_admins (lower(email));
CREATE TABLE platform_audit_logs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id   uuid,
  action     text NOT NULL,
  tenant_id  uuid, -- deliberately no FK: survives tenant purge
  metadata   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_created_idx ON platform_audit_logs (created_at DESC);

-- ---- RLS --------------------------------------------------------------------------------------------
DO $$
DECLARE t text; owner_role text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['invitations','agents','agent_versions','api_keys','usage_counters','tenant_flag_overrides'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, owner_role);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO yulona_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
  -- platform tables: owner only; the app role has no policy and no grants (definer functions only)
  FOREACH t IN ARRAY ARRAY['platform_admins','platform_audit_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, owner_role);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON invitations, agents, api_keys, usage_counters TO yulona_app;
GRANT SELECT, INSERT ON agent_versions TO yulona_app;
GRANT SELECT ON tenant_flag_overrides TO yulona_app;

-- ---- pre-auth / cross-tenant definer functions -----------------------------------------------------
CREATE FUNCTION api_key_resolve(p_hash text)
RETURNS TABLE (key_id uuid, tenant_id uuid, name text, scopes text[], rate_limit_per_minute integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE k api_keys%ROWTYPE;
BEGIN
  SELECT * INTO k FROM api_keys a WHERE a.key_hash = p_hash AND a.revoked_at IS NULL
    AND (a.expires_at IS NULL OR a.expires_at > now())
    AND EXISTS (SELECT 1 FROM tenants t WHERE t.id = a.tenant_id AND t.status = 'active');
  IF NOT FOUND THEN RETURN; END IF;
  IF k.last_used_at IS NULL OR k.last_used_at < now() - interval '1 minute' THEN
    UPDATE api_keys SET last_used_at = now() WHERE id = k.id;
  END IF;
  RETURN QUERY SELECT k.id, k.tenant_id, k.name, k.scopes, k.rate_limit_per_minute;
END $$;

CREATE FUNCTION invitation_accept(p_token_hash text, p_name text, p_password_hash text)
RETURNS TABLE (r_tenant_id uuid, r_user_id uuid, r_role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE inv invitations%ROWTYPE; v_user uuid;
BEGIN
  SELECT * INTO inv FROM invitations WHERE token_hash = p_token_hash FOR UPDATE;
  IF NOT FOUND OR inv.accepted_at IS NOT NULL OR inv.revoked_at IS NOT NULL OR inv.expires_at <= now()
     OR NOT EXISTS (SELECT 1 FROM tenants WHERE id = inv.tenant_id AND status = 'active') THEN
    RAISE EXCEPTION 'invalid_invitation' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO users (tenant_id, email, name, role, password_hash)
    VALUES (inv.tenant_id, lower(inv.email), p_name, inv.role, p_password_hash) RETURNING id INTO v_user; -- 23505 if email taken
  UPDATE invitations SET accepted_at = now() WHERE id = inv.id;
  INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, metadata)
    VALUES (inv.tenant_id, v_user, 'invitation.accepted', 'invitation', inv.id::text, jsonb_build_object('role', inv.role));
  RETURN QUERY SELECT inv.tenant_id, v_user, inv.role;
END $$;

-- ---- super admin functions -------------------------------------------------------------------------
CREATE FUNCTION sa_find_admin(p_email text)
RETURNS TABLE (admin_id uuid, email text, name text, password_hash text, status text, locked_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, email, name, password_hash, status, locked_until FROM platform_admins WHERE lower(email) = lower(p_email) LIMIT 1
$$;
CREATE FUNCTION sa_get_admin(p_id uuid)
RETURNS TABLE (admin_id uuid, email text, name text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, email, name, status FROM platform_admins WHERE id = p_id
$$;
CREATE FUNCTION sa_record_login(p_id uuid, p_success boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_success THEN
    UPDATE platform_admins SET failed_login_count = 0, locked_until = NULL WHERE id = p_id;
  ELSE
    UPDATE platform_admins SET failed_login_count = failed_login_count + 1,
      locked_until = CASE WHEN failed_login_count + 1 >= 5
        THEN now() + make_interval(secs => LEAST(900, 30 * power(2, failed_login_count + 1 - 5))) ELSE locked_until END
    WHERE id = p_id;
  END IF;
END $$;

CREATE FUNCTION sa_list_tenants(p_q text, p_limit integer, p_offset integer)
RETURNS TABLE (id uuid, name text, status text, plan_key text, deleted_at timestamptz, created_at timestamptz, user_count bigint, total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.name, t.status, t.plan_key, t.deleted_at, t.created_at,
         (SELECT count(*) FROM users u WHERE u.tenant_id = t.id), count(*) OVER ()
  FROM tenants t
  WHERE p_q IS NULL OR t.name ILIKE '%' || replace(replace(p_q, '%', ''), '_', '') || '%'
  ORDER BY t.created_at DESC LIMIT LEAST(GREATEST(p_limit,1),200) OFFSET GREATEST(p_offset,0)
$$;
CREATE FUNCTION sa_get_tenant(p_id uuid)
RETURNS TABLE (id uuid, name text, status text, plan_key text, deleted_at timestamptz, created_at timestamptz, user_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.name, t.status, t.plan_key, t.deleted_at, t.created_at, (SELECT count(*) FROM users u WHERE u.tenant_id = t.id)
  FROM tenants t WHERE t.id = p_id
$$;

CREATE FUNCTION sa_create_tenant(p_admin uuid, p_name text, p_plan text, p_owner_email text, p_owner_name text, p_password_hash text)
RETURNS TABLE (r_tenant_id uuid, r_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_t uuid; v_u uuid;
BEGIN
  INSERT INTO tenants (name, plan_key) VALUES (p_name, p_plan) RETURNING id INTO v_t;
  INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES (v_t, lower(p_owner_email), p_owner_name, 'owner', p_password_hash) RETURNING id INTO v_u;
  INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, metadata)
    VALUES (v_t, 'tenant.created_by_platform', 'tenant', v_t::text, jsonb_build_object('adminId', p_admin));
  INSERT INTO platform_audit_logs (admin_id, action, tenant_id, metadata) VALUES (p_admin, 'tenant.create', v_t, jsonb_build_object('plan', p_plan));
  RETURN QUERY SELECT v_t, v_u;
END $$;

CREATE FUNCTION sa_update_tenant(p_admin uuid, p_id uuid, p_name text, p_plan text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE tenants SET name = COALESCE(p_name, name), plan_key = COALESCE(p_plan, plan_key), updated_at = now()
    WHERE id = p_id AND status <> 'deleted';
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, metadata)
    VALUES (p_id, 'tenant.updated_by_platform', 'tenant', p_id::text, jsonb_build_object('adminId', p_admin, 'name', p_name, 'plan', p_plan));
  INSERT INTO platform_audit_logs (admin_id, action, tenant_id, metadata) VALUES (p_admin, 'tenant.update', p_id, jsonb_build_object('name', p_name, 'plan', p_plan));
  RETURN true;
END $$;

-- status: active | suspended | deleted. Restoring from deleted only within the 30-day grace window.
CREATE FUNCTION sa_set_tenant_status(p_admin uuid, p_id uuid, p_status text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cur tenants%ROWTYPE;
BEGIN
  IF p_status NOT IN ('active','suspended','deleted') THEN RAISE EXCEPTION 'invalid_status'; END IF;
  SELECT * INTO cur FROM tenants WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF cur.status = 'deleted' AND p_status <> 'deleted' AND cur.deleted_at < now() - interval '30 days' THEN RETURN 'expired'; END IF;
  UPDATE tenants SET status = p_status,
      deleted_at = CASE WHEN p_status = 'deleted' THEN COALESCE(cur.deleted_at, now()) ELSE NULL END,
      updated_at = now() WHERE id = p_id;
  IF p_status <> 'active' THEN
    UPDATE refresh_tokens SET revoked_at = now() WHERE tenant_id = p_id AND revoked_at IS NULL;
  END IF;
  INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, metadata)
    VALUES (p_id, 'tenant.status.' || p_status, 'tenant', p_id::text, jsonb_build_object('adminId', p_admin, 'from', cur.status));
  INSERT INTO platform_audit_logs (admin_id, action, tenant_id, metadata) VALUES (p_admin, 'tenant.status.' || p_status, p_id, jsonb_build_object('from', cur.status));
  RETURN 'ok';
END $$;

CREATE FUNCTION sa_upsert_flag(p_admin uuid, p_key text, p_description text, p_default boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO feature_flags (key, description, default_enabled) VALUES (p_key, p_description, p_default)
    ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description, default_enabled = EXCLUDED.default_enabled, updated_at = now();
  INSERT INTO platform_audit_logs (admin_id, action, metadata) VALUES (p_admin, 'flag.upsert', jsonb_build_object('key', p_key, 'default', p_default));
END $$;
CREATE FUNCTION sa_delete_flag(p_admin uuid, p_key text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM feature_flags WHERE key = p_key;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO platform_audit_logs (admin_id, action, metadata) VALUES (p_admin, 'flag.delete', jsonb_build_object('key', p_key));
  RETURN true;
END $$;
-- p_enabled NULL removes the override
CREATE FUNCTION sa_set_tenant_flag(p_admin uuid, p_tenant uuid, p_key text, p_enabled boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant) OR NOT EXISTS (SELECT 1 FROM feature_flags WHERE key = p_key) THEN RETURN false; END IF;
  IF p_enabled IS NULL THEN
    DELETE FROM tenant_flag_overrides WHERE tenant_id = p_tenant AND flag_key = p_key;
  ELSE
    INSERT INTO tenant_flag_overrides (tenant_id, flag_key, enabled) VALUES (p_tenant, p_key, p_enabled)
      ON CONFLICT (tenant_id, flag_key) DO UPDATE SET enabled = EXCLUDED.enabled;
  END IF;
  INSERT INTO platform_audit_logs (admin_id, action, tenant_id, metadata) VALUES (p_admin, 'flag.tenant_override', p_tenant, jsonb_build_object('key', p_key, 'enabled', p_enabled));
  RETURN true;
END $$;
CREATE FUNCTION sa_tenant_flag_overrides(p_tenant uuid) RETURNS TABLE (flag_key text, enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT flag_key, enabled FROM tenant_flag_overrides WHERE tenant_id = p_tenant
$$;
CREATE FUNCTION sa_set_plan_limit(p_admin uuid, p_plan text, p_metric text, p_value bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO plan_limits (plan_key, metric, limit_value) VALUES (p_plan, p_metric, p_value)
    ON CONFLICT (plan_key, metric) DO UPDATE SET limit_value = EXCLUDED.limit_value;
  INSERT INTO platform_audit_logs (admin_id, action, metadata) VALUES (p_admin, 'plan.limit', jsonb_build_object('plan', p_plan, 'metric', p_metric, 'value', p_value));
END $$;
CREATE FUNCTION sa_list_platform_audit(p_limit integer, p_offset integer)
RETURNS TABLE (id uuid, admin_id uuid, action text, tenant_id uuid, metadata jsonb, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, admin_id, action, tenant_id, metadata, created_at FROM platform_audit_logs
  ORDER BY created_at DESC LIMIT LEAST(GREATEST(p_limit,1),200) OFFSET GREATEST(p_offset,0)
$$;

-- Hard-delete tenants soft-deleted more than 30 days ago. Walks every public table with a tenant_id
-- column (so other waves' tables are covered automatically), retrying to satisfy FK order.
CREATE FUNCTION platform_purge_deleted_tenants() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t uuid; r record; pass integer; remaining boolean; n integer := 0;
BEGIN
  FOR t IN SELECT id FROM tenants WHERE status = 'deleted' AND deleted_at < now() - interval '30 days' LOOP
    FOR pass IN 1..8 LOOP
      remaining := false;
      FOR r IN SELECT c.table_name FROM information_schema.columns c
               JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
               WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' LOOP
        BEGIN
          EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', r.table_name) USING t;
        EXCEPTION WHEN foreign_key_violation THEN remaining := true;
        END;
      END LOOP;
      EXIT WHEN NOT remaining;
    END LOOP;
    BEGIN
      DELETE FROM tenants WHERE id = t;
      n := n + 1;
      INSERT INTO platform_audit_logs (action, tenant_id) VALUES ('tenant.purged', t);
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
  END LOOP;
  RETURN n;
END $$;

REVOKE ALL ON FUNCTION
  api_key_resolve(text), invitation_accept(text,text,text), sa_find_admin(text), sa_get_admin(uuid), sa_record_login(uuid,boolean),
  sa_list_tenants(text,integer,integer), sa_get_tenant(uuid), sa_create_tenant(uuid,text,text,text,text,text),
  sa_update_tenant(uuid,uuid,text,text), sa_set_tenant_status(uuid,uuid,text), sa_upsert_flag(uuid,text,text,boolean),
  sa_delete_flag(uuid,text), sa_set_tenant_flag(uuid,uuid,text,boolean), sa_tenant_flag_overrides(uuid),
  sa_set_plan_limit(uuid,text,text,bigint), sa_list_platform_audit(integer,integer), platform_purge_deleted_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  api_key_resolve(text), invitation_accept(text,text,text), sa_find_admin(text), sa_get_admin(uuid), sa_record_login(uuid,boolean),
  sa_list_tenants(text,integer,integer), sa_get_tenant(uuid), sa_create_tenant(uuid,text,text,text,text,text),
  sa_update_tenant(uuid,uuid,text,text), sa_set_tenant_status(uuid,uuid,text), sa_upsert_flag(uuid,text,text,boolean),
  sa_delete_flag(uuid,text), sa_set_tenant_flag(uuid,uuid,text,boolean), sa_tenant_flag_overrides(uuid),
  sa_set_plan_limit(uuid,text,text,bigint), sa_list_platform_audit(integer,integer), platform_purge_deleted_tenants() TO yulona_app;
