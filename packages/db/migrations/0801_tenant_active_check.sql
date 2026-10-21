-- 0801 qa-security: access tokens of suspended/deleted tenants stop working immediately (not only at refresh time).
CREATE FUNCTION tenant_is_active(p_tenant uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant AND status = 'active')
$$;
REVOKE ALL ON FUNCTION tenant_is_active(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_is_active(uuid) TO yulona_app;
