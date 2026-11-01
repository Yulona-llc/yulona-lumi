-- Admin auth, sessions, TOTP and admin management (SECURITY DEFINER, explicit columns).
-- Grants are applied for every sa_* function in 0990.

CREATE FUNCTION sa_find_admin_v2(p_email text)
RETURNS TABLE (admin_id uuid, email text, name text, password_hash text, status text, locked_until timestamptz, role text, totp_enabled boolean, must_change_password boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, email, name, password_hash, status, locked_until, role, totp_enabled_at IS NOT NULL, must_change_password
  FROM platform_admins WHERE lower(email) = lower(p_email) LIMIT 1
$$;

-- one lookup per request: identity, role and whether the session family is still alive
CREATE FUNCTION sa_admin_context(p_admin uuid, p_family uuid)
RETURNS TABLE (admin_id uuid, email text, name text, status text, role text, totp_enabled boolean, must_change_password boolean, session_active boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT a.id, a.email, a.name, a.status, a.role, a.totp_enabled_at IS NOT NULL, a.must_change_password,
    EXISTS (SELECT 1 FROM admin_sessions s WHERE s.family_id = p_family AND s.admin_id = a.id AND s.revoked_at IS NULL AND s.expires_at > now())
  FROM platform_admins a WHERE a.id = p_admin
$$;

CREATE FUNCTION sa_admin_session_create(p_admin uuid, p_hash text, p_expires timestamptz, p_ip text, p_ua text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_family uuid := gen_random_uuid();
BEGIN
  INSERT INTO admin_sessions (admin_id, family_id, token_hash, expires_at, ip, user_agent)
    VALUES (p_admin, v_family, p_hash, p_expires, left(p_ip, 64), left(p_ua, 300));
  UPDATE platform_admins SET last_login_at = now() WHERE id = p_admin;
  RETURN v_family;
END $$;

-- Rotation with reuse detection: a token used long ago and presented again revokes the whole family.
CREATE FUNCTION sa_admin_session_rotate(p_old_hash text, p_new_hash text, p_expires timestamptz, p_ip text, p_ua text)
RETURNS TABLE (r_status text, r_admin uuid, r_family uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s admin_sessions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM admin_sessions WHERE token_hash = p_old_hash FOR UPDATE;
  IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at <= now() THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  IF s.used_at IS NOT NULL THEN
    IF s.used_at > now() - interval '10 seconds' THEN -- two tabs refreshing at once: reject, do not punish
      RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
    END IF;
    UPDATE admin_sessions SET revoked_at = now() WHERE family_id = s.family_id AND revoked_at IS NULL;
    INSERT INTO platform_audit_logs (admin_id, action, metadata) VALUES (s.admin_id, 'admin.session_reuse', jsonb_build_object('family', s.family_id));
    RETURN QUERY SELECT 'reuse'::text, s.admin_id, s.family_id; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE id = s.admin_id AND status = 'active') THEN
    UPDATE admin_sessions SET revoked_at = now() WHERE family_id = s.family_id AND revoked_at IS NULL;
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid, NULL::uuid; RETURN;
  END IF;
  UPDATE admin_sessions SET used_at = now() WHERE id = s.id;
  INSERT INTO admin_sessions (admin_id, family_id, token_hash, expires_at, ip, user_agent)
    VALUES (s.admin_id, s.family_id, p_new_hash, p_expires, left(p_ip, 64), left(p_ua, 300));
  RETURN QUERY SELECT 'ok'::text, s.admin_id, s.family_id;
END $$;

CREATE FUNCTION sa_admin_session_revoke(p_family uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE admin_sessions SET revoked_at = now() WHERE family_id = p_family AND revoked_at IS NULL
$$;
CREATE FUNCTION sa_admin_sessions_revoke_all(p_admin uuid, p_except uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = p_admin AND revoked_at IS NULL AND (p_except IS NULL OR family_id <> p_except)
$$;
CREATE FUNCTION sa_admin_session_family_of(p_hash text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT family_id FROM admin_sessions WHERE token_hash = p_hash
$$;

-- ---- TOTP -------------------------------------------------------------------------------------------------
CREATE FUNCTION sa_admin_totp_state(p_admin uuid)
RETURNS TABLE (secret_encrypted text, pending_encrypted text, enabled boolean, last_step bigint, recovery_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT totp_secret_encrypted, totp_pending_encrypted, totp_enabled_at IS NOT NULL, totp_last_step, COALESCE(cardinality(totp_recovery_hashes), 0)
  FROM platform_admins WHERE id = p_admin
$$;
CREATE FUNCTION sa_admin_totp_set_pending(p_admin uuid, p_enc text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE platform_admins SET totp_pending_encrypted = p_enc WHERE id = p_admin AND totp_enabled_at IS NULL
$$;
CREATE FUNCTION sa_admin_totp_enable(p_admin uuid, p_hashes text[], p_step bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE platform_admins SET totp_secret_encrypted = totp_pending_encrypted, totp_pending_encrypted = NULL, totp_enabled_at = now(),
      totp_recovery_hashes = p_hashes, totp_last_step = p_step, updated_at = now()
    WHERE id = p_admin AND totp_pending_encrypted IS NOT NULL AND totp_enabled_at IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO platform_audit_logs (admin_id, action) VALUES (p_admin, 'admin.2fa.enabled');
  RETURN true;
END $$;
CREATE FUNCTION sa_admin_totp_disable(p_admin uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (
    UPDATE platform_admins SET totp_secret_encrypted = NULL, totp_pending_encrypted = NULL, totp_enabled_at = NULL,
      totp_recovery_hashes = '{}', totp_last_step = NULL, updated_at = now() WHERE id = p_admin RETURNING id)
  INSERT INTO platform_audit_logs (admin_id, action) SELECT id, 'admin.2fa.disabled' FROM u
$$;
-- replay protection: a time step can be accepted once
CREATE FUNCTION sa_admin_totp_accept(p_admin uuid, p_step bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE platform_admins SET totp_last_step = p_step WHERE id = p_admin AND (totp_last_step IS NULL OR totp_last_step < p_step);
  RETURN FOUND;
END $$;
CREATE FUNCTION sa_admin_use_recovery(p_admin uuid, p_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE platform_admins SET totp_recovery_hashes = array_remove(totp_recovery_hashes, p_hash)
    WHERE id = p_admin AND p_hash = ANY (totp_recovery_hashes);
  RETURN FOUND;
END $$;

CREATE FUNCTION sa_admin_set_password(p_admin uuid, p_hash text, p_must_change boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH u AS (UPDATE platform_admins SET password_hash = p_hash, must_change_password = p_must_change, failed_login_count = 0, locked_until = NULL, updated_at = now()
             WHERE id = p_admin RETURNING id)
  INSERT INTO platform_audit_logs (admin_id, action) SELECT id, 'admin.password_changed' FROM u
$$;

-- ---- generic audit helpers ----------------------------------------------------------------------------------
CREATE FUNCTION sa_audit_event(p_admin uuid, p_action text, p_tenant uuid, p_metadata jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO platform_audit_logs (admin_id, action, tenant_id, metadata) VALUES (p_admin, left(p_action, 80), p_tenant, COALESCE(p_metadata, '{}'::jsonb))
$$;
-- read audit, debounced per admin + tenant + action; true when a row was written
CREATE FUNCTION sa_audit_read(p_admin uuid, p_action text, p_tenant uuid, p_minutes integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_admin::text || coalesce(p_tenant::text, '') || p_action));
  IF EXISTS (SELECT 1 FROM platform_audit_logs WHERE admin_id = p_admin AND action = p_action AND tenant_id IS NOT DISTINCT FROM p_tenant
             AND created_at > now() - make_interval(mins => p_minutes)) THEN RETURN false; END IF;
  INSERT INTO platform_audit_logs (admin_id, action, tenant_id) VALUES (p_admin, p_action, p_tenant);
  RETURN true;
END $$;

-- ---- admin management (owner only at the API; last-owner protection here) -------------------------------------------
CREATE FUNCTION sa_admin_list()
RETURNS TABLE (id uuid, email text, name text, role text, status text, totp_enabled boolean, last_login_at timestamptz, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, email, name, role, status, totp_enabled_at IS NOT NULL, last_login_at, created_at FROM platform_admins ORDER BY created_at, id
$$;
CREATE FUNCTION sa_admin_get(p_id uuid)
RETURNS TABLE (id uuid, email text, name text, role text, status text, totp_enabled boolean, last_login_at timestamptz, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, email, name, role, status, totp_enabled_at IS NOT NULL, last_login_at, created_at FROM platform_admins WHERE id = p_id
$$;
-- p_actor NULL = bootstrap by the seed script; 23505 when the email exists
CREATE FUNCTION sa_admin_create(p_actor uuid, p_email text, p_name text, p_role text, p_hash text, p_must_change boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO platform_admins (email, name, role, password_hash, must_change_password) VALUES (lower(p_email), p_name, p_role, p_hash, p_must_change) RETURNING id INTO v_id;
  INSERT INTO platform_audit_logs (admin_id, action, metadata) VALUES (p_actor, 'admin.create', jsonb_build_object('adminId', v_id, 'role', p_role));
  RETURN v_id;
END $$;
-- 'ok' | 'not_found' | 'last_owner'
CREATE FUNCTION sa_admin_update(p_actor uuid, p_id uuid, p_name text, p_role text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cur platform_admins%ROWTYPE;
BEGIN
  PERFORM 1 FROM platform_admins WHERE role = 'owner' AND status = 'active' FOR UPDATE;
  SELECT * INTO cur FROM platform_admins WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF p_role IS NOT NULL AND p_role <> 'owner' AND cur.role = 'owner' AND cur.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM platform_admins WHERE role = 'owner' AND status = 'active' AND id <> p_id) THEN RETURN 'last_owner'; END IF;
  UPDATE platform_admins SET name = COALESCE(p_name, name), role = COALESCE(p_role, role), updated_at = now() WHERE id = p_id;
  INSERT INTO platform_audit_logs (admin_id, action, metadata)
    VALUES (p_actor, 'admin.update', jsonb_build_object('adminId', p_id, 'role', p_role, 'from', cur.role, 'name', p_name));
  RETURN 'ok';
END $$;
-- 'ok' | 'not_found' | 'last_owner' | 'self'
CREATE FUNCTION sa_admin_set_status(p_actor uuid, p_id uuid, p_status text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE cur platform_admins%ROWTYPE;
BEGIN
  IF p_status NOT IN ('active','disabled') THEN RAISE EXCEPTION 'invalid_status'; END IF;
  PERFORM 1 FROM platform_admins WHERE role = 'owner' AND status = 'active' FOR UPDATE;
  SELECT * INTO cur FROM platform_admins WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF p_status = 'disabled' THEN
    IF p_actor = p_id THEN RETURN 'self'; END IF;
    IF cur.role = 'owner' AND cur.status = 'active' AND NOT EXISTS (SELECT 1 FROM platform_admins WHERE role = 'owner' AND status = 'active' AND id <> p_id) THEN RETURN 'last_owner'; END IF;
    UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = p_id AND revoked_at IS NULL;
  END IF;
  UPDATE platform_admins SET status = p_status, updated_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = p_id;
  INSERT INTO platform_audit_logs (admin_id, action, metadata)
    VALUES (p_actor, CASE WHEN p_status = 'disabled' THEN 'admin.deactivate' ELSE 'admin.activate' END, jsonb_build_object('adminId', p_id));
  RETURN 'ok';
END $$;
CREATE FUNCTION sa_admin_reset_2fa(p_actor uuid, p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE platform_admins SET totp_secret_encrypted = NULL, totp_pending_encrypted = NULL, totp_enabled_at = NULL, totp_recovery_hashes = '{}',
    totp_last_step = NULL, updated_at = now() WHERE id = p_id;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = p_id AND revoked_at IS NULL;
  INSERT INTO platform_audit_logs (admin_id, action, metadata) VALUES (p_actor, 'admin.2fa.reset', jsonb_build_object('adminId', p_id));
  RETURN true;
END $$;
CREATE FUNCTION sa_admin_reset_password(p_actor uuid, p_id uuid, p_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE platform_admins SET password_hash = p_hash, must_change_password = true, failed_login_count = 0, locked_until = NULL, updated_at = now() WHERE id = p_id;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE admin_sessions SET revoked_at = now() WHERE admin_id = p_id AND revoked_at IS NULL;
  INSERT INTO platform_audit_logs (admin_id, action, metadata) VALUES (p_actor, 'admin.reset_password', jsonb_build_object('adminId', p_id));
  RETURN true;
END $$;
