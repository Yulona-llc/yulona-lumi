-- Phase 1 foundation. Run as the owner role (yulona_owner); the app role is yulona_app.
CREATE EXTENSION IF NOT EXISTS vector;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yulona_app') THEN
    CREATE ROLE yulona_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yulona_app' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'yulona_app must not be SUPERUSER or BYPASSRLS';
  END IF;
  IF current_user = 'yulona_app' THEN
    RAISE EXCEPTION 'migrations must run as the owner role, not yulona_app';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO yulona_app;

-- Current tenant from the per-transaction GUC. Unset/empty => NULL => policies match nothing.
CREATE FUNCTION app_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.current_tenant_id', true), '')::uuid $$;

CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  email              text NOT NULL CHECK (char_length(email) <= 254),
  name               text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  role               text NOT NULL CHECK (role IN ('owner','admin','agent')),
  password_hash      text NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
-- Login is by email only, so email is globally unique (case-insensitive).
CREATE UNIQUE INDEX users_email_lower_uniq ON users (lower(email));
CREATE INDEX users_tenant_created_idx ON users (tenant_id, created_at);

CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL,
  family_id  uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  revoked_at timestamptz,
  user_agent text,
  ip         text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX refresh_tokens_tenant_user_idx ON refresh_tokens (tenant_id, user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_expires_idx ON refresh_tokens (expires_at);

CREATE TABLE audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  actor_user_id uuid,
  action        text NOT NULL,
  resource_type text,
  resource_id   text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip            text,
  request_id    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX audit_logs_tenant_created_idx ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX audit_logs_tenant_action_idx ON audit_logs (tenant_id, action, created_at DESC);

-- ---- RLS: ENABLE + FORCE on every tenant table -------------------------------------------------
-- App role: only rows of the current tenant. Owner role: unrestricted policy so that the narrowly
-- scoped SECURITY DEFINER pre-auth functions below (owned by the owner) can operate cross-tenant.
-- The app role itself never gets a cross-tenant policy.
DO $$
DECLARE t text; owner_role text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenants','users','refresh_tokens','audit_logs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, owner_role);
  END LOOP;
  CREATE POLICY tenant_isolation ON tenants FOR ALL TO yulona_app
    USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());
  FOREACH t IN ARRAY ARRAY['users','refresh_tokens','audit_logs'] LOOP
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO yulona_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

-- ---- Least-privilege grants for the app role (no DELETE anywhere; audit_logs append-only) -------
GRANT SELECT, UPDATE ON tenants TO yulona_app;
GRANT SELECT, INSERT, UPDATE ON users TO yulona_app;
GRANT SELECT, INSERT, UPDATE ON refresh_tokens TO yulona_app;
GRANT SELECT, INSERT ON audit_logs TO yulona_app;

-- ---- Pre-auth path: narrowly scoped SECURITY DEFINER functions ------------------------------------
-- Login/register/refresh must look rows up before a tenant is known. These functions are the ONLY
-- cross-tenant access the app role has; each does one specific thing and returns minimal data.

CREATE FUNCTION auth_find_user(p_email text)
RETURNS TABLE (user_id uuid, tenant_id uuid, email text, name text, role text, password_hash text,
               locked_until timestamptz, user_status text, tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.id, u.tenant_id, u.email, u.name, u.role, u.password_hash, u.locked_until, u.status, t.status
  FROM users u JOIN tenants t ON t.id = u.tenant_id
  WHERE lower(u.email) = lower(p_email)
  LIMIT 1
$$;

CREATE FUNCTION auth_register(p_tenant_name text, p_email text, p_password_hash text, p_name text,
                              p_ip text, p_request_id text)
RETURNS TABLE (r_tenant_id uuid, r_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid; v_user uuid;
BEGIN
  INSERT INTO tenants (name) VALUES (p_tenant_name) RETURNING id INTO v_tenant;
  INSERT INTO users (tenant_id, email, name, role, password_hash)
    VALUES (v_tenant, lower(p_email), p_name, 'owner', p_password_hash) RETURNING id INTO v_user;
  INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type, resource_id, ip, request_id)
    VALUES (v_tenant, v_user, 'auth.register', 'tenant', v_tenant::text, p_ip, p_request_id);
  RETURN QUERY SELECT v_tenant, v_user;
END $$;

-- Exponential lockout: from the 5th consecutive failure, 30s * 2^(n-5), capped at 15 minutes.
CREATE FUNCTION auth_record_login(p_user_id uuid, p_success boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_success THEN
    UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now(), updated_at = now()
      WHERE id = p_user_id;
  ELSE
    UPDATE users SET
      failed_login_count = failed_login_count + 1,
      locked_until = CASE WHEN failed_login_count + 1 >= 5
        THEN now() + make_interval(secs => LEAST(900, 30 * power(2, failed_login_count + 1 - 5)))
        ELSE locked_until END,
      updated_at = now()
    WHERE id = p_user_id;
  END IF;
END $$;

-- Atomic rotation with reuse detection. Presenting an already-used token revokes the whole family.
CREATE FUNCTION auth_rotate_refresh(p_old_hash text, p_new_hash text, p_expires timestamptz,
                                    p_user_agent text, p_ip text)
RETURNS TABLE (r_status text, r_tenant_id uuid, r_user_id uuid, r_family_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE tok refresh_tokens%ROWTYPE;
BEGIN
  SELECT * INTO tok FROM refresh_tokens WHERE token_hash = p_old_hash FOR UPDATE;
  IF NOT FOUND OR tok.revoked_at IS NOT NULL OR tok.expires_at <= now() THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  IF tok.used_at IS NOT NULL THEN
    UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = tok.family_id AND revoked_at IS NULL;
    RETURN QUERY SELECT 'reuse'::text, tok.tenant_id, tok.user_id, tok.family_id; RETURN;
  END IF;
  UPDATE refresh_tokens SET used_at = now() WHERE id = tok.id;
  INSERT INTO refresh_tokens (tenant_id, user_id, family_id, token_hash, expires_at, user_agent, ip)
    VALUES (tok.tenant_id, tok.user_id, tok.family_id, p_new_hash, p_expires, p_user_agent, p_ip);
  RETURN QUERY SELECT 'ok'::text, tok.tenant_id, tok.user_id, tok.family_id;
END $$;

CREATE FUNCTION auth_revoke_refresh_family(p_hash text)
RETURNS TABLE (r_tenant_id uuid, r_user_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE tok refresh_tokens%ROWTYPE;
BEGIN
  SELECT * INTO tok FROM refresh_tokens WHERE token_hash = p_hash;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = tok.family_id AND revoked_at IS NULL;
  RETURN QUERY SELECT tok.tenant_id, tok.user_id;
END $$;

REVOKE ALL ON FUNCTION auth_find_user(text), auth_register(text,text,text,text,text,text),
  auth_record_login(uuid,boolean), auth_rotate_refresh(text,text,timestamptz,text,text),
  auth_revoke_refresh_family(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user(text), auth_register(text,text,text,text,text,text),
  auth_record_login(uuid,boolean), auth_rotate_refresh(text,text,timestamptz,text,text),
  auth_revoke_refresh_family(text) TO yulona_app;
