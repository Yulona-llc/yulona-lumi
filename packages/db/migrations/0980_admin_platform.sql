-- Wave 6 (migration range 0980-0999): the separate platform-admin service.
-- 0980 roles + tables, 0981 auth/admin-management functions, 0982 customer-360 reads, 0983 support actions,
-- 0990 privilege split (sa_* only for yulona_admin, revoked from yulona_app).
-- Run as the owner role. Platform tables have an owner-only policy and NO grants to yulona_app or yulona_admin:
-- the admin service reaches them through SECURITY DEFINER sa_* functions only.

-- ---- the admin service's login role (NOLOGIN here; deploy sets the password, like yulona_app) ----------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yulona_admin') THEN
    CREATE ROLE yulona_admin NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'yulona_admin' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'yulona_admin must not be SUPERUSER or BYPASSRLS';
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO yulona_admin; -- needed to call functions; no table privileges are ever granted

-- ---- admin roles, 2FA and password state ---------------------------------------------------------------------
ALTER TABLE platform_admins
  ADD COLUMN role                    text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','support','billing')),
  ADD COLUMN totp_secret_encrypted   text,
  ADD COLUMN totp_pending_encrypted  text,
  ADD COLUMN totp_enabled_at         timestamptz,
  ADD COLUMN totp_recovery_hashes    text[] NOT NULL DEFAULT '{}',
  ADD COLUMN totp_last_step          bigint,
  ADD COLUMN must_change_password    boolean NOT NULL DEFAULT false,
  ADD COLUMN last_login_at           timestamptz,
  ADD COLUMN updated_at              timestamptz NOT NULL DEFAULT now();

-- ---- admin sessions (refresh tokens; the family id is the session id inside access tokens) ---------------------------
CREATE TABLE admin_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id   uuid NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
  family_id  uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  revoked_at timestamptz,
  ip         text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_sessions_family_idx ON admin_sessions (family_id);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id);

-- ---- support data: notes and tags (no FK: they may outlive a purge decision, and carry no customer content) -----------------
CREATE TABLE tenant_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  admin_id    uuid,
  admin_email text NOT NULL,
  body        text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tenant_notes_tenant_idx ON tenant_notes (tenant_id, created_at DESC);
CREATE TABLE tenant_tags (
  tenant_id  uuid NOT NULL,
  tag        text NOT NULL CHECK (tag ~ '^[a-z0-9][a-z0-9_-]{0,29}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, tag)
);
CREATE INDEX tenant_tags_tag_idx ON tenant_tags (tag);

-- ---- impersonation: read-only flag + one-time exchange codes ---------------------------------------------------------------
ALTER TABLE impersonation_sessions ADD COLUMN read_only boolean NOT NULL DEFAULT false, ADD COLUMN exchanged_at timestamptz;
CREATE TABLE impersonation_codes (
  code_hash  text PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  session_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text; owner_role text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['admin_sessions','tenant_notes','tenant_tags','impersonation_codes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, owner_role);
  END LOOP;
END $$;
