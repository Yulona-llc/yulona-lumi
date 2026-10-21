-- 0800 qa-security: impersonation tokens are checked against their session on every request.
-- A token is valid only while its session exists, is not ended and has not expired (denylist by session id/jti-equivalent).
CREATE FUNCTION impersonation_session_active(p_session uuid, p_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM impersonation_sessions
    WHERE id = p_session AND tenant_id = p_tenant AND ended_at IS NULL AND expires_at > now()
  )
$$;
REVOKE ALL ON FUNCTION impersonation_session_active(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION impersonation_session_active(uuid, uuid) TO yulona_app;
