-- Platform: Postgres-backed job queue. Jobs are tenant rows (RLS). The worker has no tenant context
-- when claiming, so claim/complete/fail go through narrow SECURITY DEFINER functions.
CREATE TABLE jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status      text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','dead')),
  attempts    integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 50),
  run_at      timestamptz NOT NULL DEFAULT now(),
  locked_at   timestamptz,
  locked_by   text,
  last_error  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_claim_idx ON jobs (run_at) WHERE status IN ('queued','running');
CREATE INDEX jobs_tenant_created_idx ON jobs (tenant_id, created_at DESC);

ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY owner_all ON jobs FOR ALL TO %I USING (true) WITH CHECK (true)', current_user);
END $$;
CREATE POLICY tenant_isolation ON jobs FOR ALL TO yulona_app
  USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
GRANT SELECT, INSERT ON jobs TO yulona_app;

-- Claim up to p_limit due jobs (also reclaims jobs whose lock expired). Attempts is incremented here.
CREATE FUNCTION jobs_claim(p_worker text, p_names text[], p_limit integer, p_lock_secs integer)
RETURNS TABLE (id uuid, tenant_id uuid, name text, payload jsonb, attempts integer, max_attempts integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH picked AS (
    SELECT j.id FROM jobs j
    WHERE j.name = ANY(p_names)
      AND j.run_at <= now()
      AND (j.status = 'queued' OR (j.status = 'running' AND j.locked_at < now() - make_interval(secs => p_lock_secs)))
    ORDER BY j.run_at
    LIMIT GREATEST(1, LEAST(p_limit, 100))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE jobs j SET status = 'running', locked_at = now(), locked_by = p_worker,
                    attempts = j.attempts + 1, updated_at = now()
  FROM picked WHERE j.id = picked.id
  RETURNING j.id, j.tenant_id, j.name, j.payload, j.attempts, j.max_attempts
$$;

CREATE FUNCTION jobs_complete(p_id uuid, p_worker text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE jobs SET status = 'succeeded', finished_at = now(), updated_at = now(), locked_at = NULL, last_error = NULL
  WHERE id = p_id AND status = 'running' AND locked_by = p_worker
$$;

-- Retry with delay, or dead-letter when attempts are exhausted (or p_fatal). Returns the new status.
CREATE FUNCTION jobs_fail(p_id uuid, p_worker text, p_error text, p_delay_secs double precision, p_fatal boolean DEFAULT false)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_status text;
BEGIN
  UPDATE jobs SET
    status = CASE WHEN p_fatal OR attempts >= max_attempts THEN 'dead' ELSE 'queued' END,
    run_at = CASE WHEN p_fatal OR attempts >= max_attempts THEN run_at ELSE now() + make_interval(secs => p_delay_secs) END,
    finished_at = CASE WHEN p_fatal OR attempts >= max_attempts THEN now() ELSE NULL END,
    last_error = left(p_error, 2000), locked_at = NULL, locked_by = NULL, updated_at = now()
  WHERE id = p_id AND status = 'running' AND locked_by = p_worker
  RETURNING status INTO v_status;
  RETURN v_status;
END $$;

-- Housekeeping: drop finished jobs older than p_days (floor 1 day).
CREATE FUNCTION jobs_prune(p_days integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  DELETE FROM jobs WHERE status IN ('succeeded','dead') AND finished_at < now() - make_interval(days => GREATEST(1, p_days));
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
-- jobs has no DELETE grant for the app role; the definer function (owner) does the delete.

REVOKE ALL ON FUNCTION jobs_claim(text,text[],integer,integer), jobs_complete(uuid,text),
  jobs_fail(uuid,text,text,double precision,boolean), jobs_prune(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jobs_claim(text,text[],integer,integer), jobs_complete(uuid,text),
  jobs_fail(uuid,text,text,double precision,boolean), jobs_prune(integer) TO yulona_app;
