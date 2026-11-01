-- Support actions, impersonation with one-time codes, audit filters. Grants in 0990.

-- ---- notes and tags ----------------------------------------------------------------------------------------------
CREATE FUNCTION sa_add_note(p_admin uuid, p_tenant uuid, p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid; v_email text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant) THEN RETURN NULL; END IF;
  SELECT email INTO v_email FROM platform_admins WHERE id = p_admin;
  INSERT INTO tenant_notes (tenant_id, admin_id, admin_email, body) VALUES (p_tenant, p_admin, COALESCE(v_email, 'unknown'), p_body) RETURNING id INTO v_id;
  INSERT INTO platform_audit_logs (admin_id, action, tenant_id, metadata) VALUES (p_admin, 'tenant.note.add', p_tenant, jsonb_build_object('noteId', v_id));
  RETURN v_id;
END $$;
CREATE FUNCTION sa_delete_note(p_admin uuid, p_tenant uuid, p_note uuid, p_any boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM tenant_notes WHERE id = p_note AND tenant_id = p_tenant AND (p_any OR admin_id = p_admin);
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO platform_audit_logs (admin_id, action, tenant_id, metadata) VALUES (p_admin, 'tenant.note.delete', p_tenant, jsonb_build_object('noteId', p_note));
  RETURN true;
END $$;
CREATE FUNCTION sa_get_note(p_tenant uuid, p_note uuid) RETURNS TABLE (id uuid, body text, admin_id uuid, admin_email text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, body, admin_id, admin_email, created_at FROM tenant_notes WHERE id = p_note AND tenant_id = p_tenant
$$;
CREATE FUNCTION sa_set_tenant_tags(p_admin uuid, p_tenant uuid, p_tags text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant) THEN RETURN false; END IF;
  DELETE FROM tenant_tags WHERE tenant_id = p_tenant AND NOT (tag = ANY (p_tags));
  INSERT INTO tenant_tags (tenant_id, tag) SELECT p_tenant, unnest(p_tags) ON CONFLICT DO NOTHING;
  INSERT INTO platform_audit_logs (admin_id, action, tenant_id, metadata) VALUES (p_admin, 'tenant.tags', p_tenant, jsonb_build_object('tags', p_tags));
  RETURN true;
END $$;
CREATE FUNCTION sa_bulk_tags(p_admin uuid, p_tenants uuid[], p_add text[], p_remove text[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM tenants WHERE id = ANY (p_tenants);
  IF cardinality(COALESCE(p_remove, '{}')) > 0 THEN
    DELETE FROM tenant_tags WHERE tenant_id = ANY (p_tenants) AND tag = ANY (p_remove);
  END IF;
  IF cardinality(COALESCE(p_add, '{}')) > 0 THEN
    INSERT INTO tenant_tags (tenant_id, tag) SELECT t.id, g FROM tenants t, unnest(p_add) g WHERE t.id = ANY (p_tenants) ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO platform_audit_logs (admin_id, action, metadata)
    VALUES (p_admin, 'tenant.tags.bulk', jsonb_build_object('count', n, 'add', p_add, 'remove', p_remove));
  RETURN n;
END $$;

-- ---- support actions -----------------------------------------------------------------------------------------------
-- re-issue the token of a pending invitation (the raw token is generated and emailed by the admin service)
CREATE FUNCTION sa_reissue_invitation(p_admin uuid, p_tenant uuid, p_inv uuid, p_hash text, p_expires timestamptz)
RETURNS TABLE (r_email text, r_role text, r_tenant_name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE i invitations%ROWTYPE; v_name text;
BEGIN
  SELECT * INTO i FROM invitations WHERE id = p_inv AND tenant_id = p_tenant AND accepted_at IS NULL AND revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT name INTO v_name FROM tenants WHERE id = p_tenant AND status = 'active';
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE invitations SET token_hash = p_hash, expires_at = p_expires WHERE id = i.id;
  INSERT INTO platform_audit_logs (admin_id, action, tenant_id, metadata) VALUES (p_admin, 'tenant.invitation_resend', p_tenant, jsonb_build_object('invitationId', i.id));
  INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, metadata)
    VALUES (p_tenant, 'invitation.resent_by_platform', 'invitation', i.id::text, jsonb_build_object('adminId', p_admin));
  RETURN QUERY SELECT i.email, i.role, v_name;
END $$;

CREATE FUNCTION sa_dead_job_retry(p_admin uuid, p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j jobs%ROWTYPE;
BEGIN
  UPDATE jobs SET status = 'queued', attempts = 0, run_at = now(), locked_at = NULL, locked_by = NULL, finished_at = NULL, updated_at = now()
    WHERE id = p_id AND status = 'dead' RETURNING * INTO j;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO platform_audit_logs (admin_id, action, tenant_id, metadata) VALUES (p_admin, 'job.retry', j.tenant_id, jsonb_build_object('jobId', j.id, 'name', j.name));
  RETURN true;
END $$;
CREATE FUNCTION sa_dead_job_discard(p_admin uuid, p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j jobs%ROWTYPE;
BEGIN
  DELETE FROM jobs WHERE id = p_id AND status = 'dead' RETURNING * INTO j;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO platform_audit_logs (admin_id, action, tenant_id, metadata) VALUES (p_admin, 'job.discard', j.tenant_id, jsonb_build_object('jobId', j.id, 'name', j.name));
  RETURN true;
END $$;

-- ---- impersonation v2: one-time exchange code + read-only flag ----------------------------------------------------------------
-- The session starts with a short expiry (the code TTL); redeeming the code extends it to the 15 minute token lifetime.
CREATE FUNCTION sa_start_impersonation_v2(p_admin uuid, p_tenant uuid, p_user uuid, p_reason text, p_code_hash text, p_read_only boolean, p_code_ttl_secs integer)
RETURNS TABLE (r_status text, r_session uuid, r_user uuid, r_role text, r_email text, r_name text, r_tenant_name text, r_expires timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t tenants%ROWTYPE; u users%ROWTYPE; v_sid uuid; v_exp timestamptz := now() + make_interval(secs => LEAST(GREATEST(p_code_ttl_secs, 5), 120));
BEGIN
  SELECT * INTO t FROM tenants WHERE id = p_tenant;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found', NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::timestamptz; RETURN; END IF;
  IF t.status <> 'active' THEN RETURN QUERY SELECT 'tenant_inactive', NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::timestamptz; RETURN; END IF;
  IF p_user IS NOT NULL THEN
    SELECT * INTO u FROM users WHERE id = p_user AND tenant_id = p_tenant AND status = 'active';
  ELSE
    SELECT * INTO u FROM users WHERE tenant_id = p_tenant AND status = 'active' AND role = 'owner' ORDER BY created_at LIMIT 1;
  END IF;
  IF NOT FOUND THEN RETURN QUERY SELECT 'user_not_found', NULL::uuid, NULL::uuid, NULL::text, NULL::text, NULL::text, NULL::text, NULL::timestamptz; RETURN; END IF;
  INSERT INTO impersonation_sessions (admin_id, tenant_id, user_id, reason, expires_at, read_only) VALUES (p_admin, p_tenant, u.id, p_reason, v_exp, p_read_only) RETURNING id INTO v_sid;
  INSERT INTO impersonation_codes (code_hash, tenant_id, session_id, expires_at) VALUES (p_code_hash, p_tenant, v_sid, v_exp);
  INSERT INTO platform_audit_logs (admin_id, action, tenant_id, metadata)
    VALUES (p_admin, 'impersonation.start', p_tenant, jsonb_build_object('sessionId', v_sid, 'userId', u.id, 'reason', p_reason, 'readOnly', p_read_only));
  INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, metadata)
    VALUES (p_tenant, 'impersonation.started', 'impersonation', v_sid::text,
            jsonb_build_object('impersonatorId', p_admin, 'asUserId', u.id, 'reason', p_reason, 'readOnly', p_read_only));
  RETURN QUERY SELECT 'ok', v_sid, u.id, CASE WHEN u.role = 'owner' THEN 'admin' ELSE u.role END, u.email, u.name, t.name, v_exp;
END $$;

-- Customer API side (granted to yulona_app, NOT an sa_ function): redeem a code once. status ok | invalid.
CREATE FUNCTION impersonation_exchange(p_code_hash text)
RETURNS TABLE (r_status text, r_session uuid, r_admin uuid, r_tenant uuid, r_user uuid, r_role text, r_read_only boolean, r_email text, r_name text, r_tenant_name text, r_expires timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE c impersonation_codes%ROWTYPE; s impersonation_sessions%ROWTYPE; u users%ROWTYPE; v_tname text; v_exp timestamptz;
BEGIN
  SELECT * INTO c FROM impersonation_codes WHERE code_hash = p_code_hash FOR UPDATE;
  IF NOT FOUND OR c.used_at IS NOT NULL OR c.expires_at <= now() THEN
    RETURN QUERY SELECT 'invalid', NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::boolean, NULL::text, NULL::text, NULL::text, NULL::timestamptz; RETURN;
  END IF;
  UPDATE impersonation_codes SET used_at = now() WHERE code_hash = p_code_hash;
  SELECT * INTO s FROM impersonation_sessions WHERE id = c.session_id;
  SELECT * INTO u FROM users WHERE id = s.user_id AND tenant_id = s.tenant_id AND status = 'active';
  SELECT name INTO v_tname FROM tenants WHERE id = s.tenant_id AND status = 'active';
  IF s.id IS NULL OR s.ended_at IS NOT NULL OR u.id IS NULL OR v_tname IS NULL THEN
    RETURN QUERY SELECT 'invalid', NULL::uuid, NULL::uuid, NULL::uuid, NULL::uuid, NULL::text, NULL::boolean, NULL::text, NULL::text, NULL::text, NULL::timestamptz; RETURN;
  END IF;
  v_exp := now() + interval '15 minutes';
  UPDATE impersonation_sessions SET expires_at = v_exp, exchanged_at = now() WHERE id = s.id;
  INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, metadata)
    VALUES (s.tenant_id, 'impersonation.exchanged', 'impersonation', s.id::text, jsonb_build_object('impersonatorId', s.admin_id, 'readOnly', s.read_only));
  RETURN QUERY SELECT 'ok', s.id, s.admin_id, s.tenant_id, u.id, CASE WHEN u.role = 'owner' THEN 'admin' ELSE u.role END, s.read_only, u.email, u.name, v_tname, v_exp;
END $$;
REVOKE ALL ON FUNCTION impersonation_exchange(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION impersonation_exchange(text) TO yulona_app;

CREATE FUNCTION sa_list_impersonations(p_tenant uuid, p_admin uuid, p_limit integer, p_offset integer)
RETURNS TABLE (id uuid, admin_id uuid, admin_email text, tenant_id uuid, tenant_name text, user_id uuid, reason text, read_only boolean,
  started_at timestamptz, expires_at timestamptz, ended_at timestamptz, exchanged_at timestamptz, total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, s.admin_id, a.email, s.tenant_id, t.name, s.user_id, s.reason, s.read_only, s.started_at, s.expires_at, s.ended_at, s.exchanged_at, count(*) OVER ()
  FROM impersonation_sessions s LEFT JOIN platform_admins a ON a.id = s.admin_id LEFT JOIN tenants t ON t.id = s.tenant_id
  WHERE (p_tenant IS NULL OR s.tenant_id = p_tenant) AND (p_admin IS NULL OR s.admin_id = p_admin)
  ORDER BY s.started_at DESC, s.id LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0)
$$;

-- ---- audit list with filters (also used by the export; p_action ending in '.' is a prefix) --------------------------------------------
CREATE FUNCTION sa_list_platform_audit_v2(p_admin uuid, p_tenant uuid, p_action text, p_from timestamptz, p_to timestamptz, p_limit integer, p_offset integer)
RETURNS TABLE (id uuid, admin_id uuid, admin_email text, action text, tenant_id uuid, tenant_name text, metadata jsonb, created_at timestamptz, total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.id, l.admin_id, a.email, l.action, l.tenant_id, t.name, l.metadata, l.created_at, count(*) OVER ()
  FROM platform_audit_logs l LEFT JOIN platform_admins a ON a.id = l.admin_id LEFT JOIN tenants t ON t.id = l.tenant_id
  WHERE (p_admin IS NULL OR l.admin_id = p_admin) AND (p_tenant IS NULL OR l.tenant_id = p_tenant)
    AND (p_action IS NULL OR CASE WHEN right(p_action, 1) = '.' THEN l.action LIKE replace(replace(replace(p_action, '\', '\\'), '%', '\%'), '_', '\_') || '%' ELSE l.action = p_action END)
    AND (p_from IS NULL OR l.created_at >= p_from) AND (p_to IS NULL OR l.created_at < p_to)
  ORDER BY l.created_at DESC, l.id LIMIT LEAST(GREATEST(p_limit, 1), 50000) OFFSET GREATEST(p_offset, 0)
$$;
