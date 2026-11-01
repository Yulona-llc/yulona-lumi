-- Privilege split: cross-tenant sa_* functions belong to the platform-admin service only.
--  * yulona_admin: EXECUTE on every sa_* function, no table privileges (granted nothing in 0980)
--  * yulona_app: loses EXECUTE on every sa_* function, so a compromise of the customer API cannot call them
-- Non-sa_ helpers the customer API needs (impersonation_session_active, tenant_is_active, impersonation_exchange, ...) stay granted.
-- Runs over the catalog, so sa_* functions created by 0980-0983 are covered; the isolation tests catch later additions.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proname LIKE 'sa\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM yulona_app', f.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO yulona_admin', f.sig);
  END LOOP;
END $$;
