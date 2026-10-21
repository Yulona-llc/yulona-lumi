-- Billing + super-admin ops (migration range 0700-0799): billing state, webhook idempotency, plan prices,
-- daily usage rollup, impersonation sessions, worker heartbeats, platform analytics/health functions.
-- Run as the owner role. Platform-level tables have no tenant policy for yulona_app: definer functions only.

-- ---- billing state (one row per tenant) ------------------------------------------------------------
CREATE TABLE billing_customers (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id),
  customer_id          text NOT NULL UNIQUE,
  subscription_id      text,
  status               text NOT NULL DEFAULT 'none' CHECK (status IN ('none','active','trialing','past_due','canceled')),
  plan_key             text REFERENCES plans(key),
  current_period_end   timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  grace_until          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_customers_grace_idx ON billing_customers (grace_until) WHERE grace_until IS NOT NULL;

-- processed provider webhook events (idempotency); platform-level, definer access only
CREATE TABLE billing_events (
  event_id    text PRIMARY KEY,
  type        text NOT NULL,
  tenant_id   uuid,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plan_prices (
  plan_key      text PRIMARY KEY REFERENCES plans(key) ON DELETE CASCADE,
  monthly_cents integer NOT NULL CHECK (monthly_cents >= 0)
);
INSERT INTO plan_prices (plan_key, monthly_cents) VALUES ('free', 0), ('pro', 4900), ('enterprise', 0), ('self_hosted', 0);

-- ---- daily usage rollup (chart data) -----------------------------------------------------------------
CREATE TABLE usage_daily (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  day       date NOT NULL,
  metric    text NOT NULL CHECK (metric IN ('conversations','messages','llm_tokens','new_contacts')),
  value     bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day, metric)
);

-- ---- impersonation sessions (platform-level audit record) ------------------------------------------------
CREATE TABLE impersonation_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id   uuid NOT NULL,
  tenant_id  uuid NOT NULL, -- deliberately no FK: survives tenant purge
  user_id    uuid NOT NULL,
  reason     text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at   timestamptz
);
CREATE INDEX impersonation_sessions_tenant_idx ON impersonation_sessions (tenant_id, started_at DESC);

CREATE TABLE worker_heartbeats (
  name    text PRIMARY KEY,
  beat_at timestamptz NOT NULL DEFAULT now()
);

-- ---- RLS ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text; owner_role text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['billing_customers','usage_daily'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, owner_role);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO yulona_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
  -- platform-level: owner only (impersonation_sessions has a tenant_id column so the purge can delete it)
  FOREACH t IN ARRAY ARRAY['billing_events','impersonation_sessions','worker_heartbeats'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, owner_role);
  END LOOP;
END $$;

-- tenants may read their billing row and create it once (customer id); every other write is a definer function
GRANT SELECT, INSERT ON billing_customers TO yulona_app;
GRANT SELECT ON usage_daily, plan_prices TO yulona_app;

-- ---- billing webhook application (idempotent) -----------------------------------------------------------------
-- p_action: subscription_set | subscription_deleted | payment_failed | payment_succeeded
-- returns: applied | duplicate | unknown_tenant
CREATE FUNCTION billing_apply_event(
  p_event_id text, p_type text, p_action text, p_tenant uuid, p_customer text, p_subscription text,
  p_plan text, p_status text, p_period_end timestamptz, p_cancel_at_end boolean, p_grace_days integer
) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_t uuid; cur billing_customers%ROWTYPE; v_status text; v_plan text; v_grace timestamptz; v_new_plan text;
BEGIN
  INSERT INTO billing_events (event_id, type) VALUES (p_event_id, p_type) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN 'duplicate'; END IF;

  IF p_customer IS NOT NULL THEN
    SELECT tenant_id INTO v_t FROM billing_customers WHERE customer_id = p_customer;
  END IF;
  IF v_t IS NULL AND p_tenant IS NOT NULL AND EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant) THEN v_t := p_tenant; END IF;
  IF v_t IS NULL THEN
    DELETE FROM billing_events WHERE event_id = p_event_id; -- allow a later redelivery once we know the tenant
    RETURN 'unknown_tenant';
  END IF;
  UPDATE billing_events SET tenant_id = v_t WHERE event_id = p_event_id;

  SELECT * INTO cur FROM billing_customers WHERE tenant_id = v_t FOR UPDATE;
  IF NOT FOUND THEN
    IF p_customer IS NULL THEN DELETE FROM billing_events WHERE event_id = p_event_id; RETURN 'unknown_tenant'; END IF;
    INSERT INTO billing_customers (tenant_id, customer_id) VALUES (v_t, p_customer);
    SELECT * INTO cur FROM billing_customers WHERE tenant_id = v_t;
  END IF;

  v_status := cur.status; v_plan := cur.plan_key; v_grace := cur.grace_until;
  IF p_plan IS NOT NULL AND NOT EXISTS (SELECT 1 FROM plans WHERE key = p_plan) THEN p_plan := NULL; END IF;

  IF p_action = 'subscription_set' THEN
    IF p_status IN ('active','trialing') THEN
      v_status := p_status; v_grace := NULL; v_plan := COALESCE(p_plan, v_plan); v_new_plan := v_plan;
    ELSIF p_status IN ('past_due','unpaid') THEN
      v_status := 'past_due'; v_grace := COALESCE(v_grace, now() + make_interval(days => p_grace_days));
    ELSIF p_status IN ('canceled','incomplete_expired') THEN
      v_status := 'canceled'; v_grace := NULL; v_plan := 'free'; v_new_plan := 'free';
    END IF; -- incomplete / paused / unknown: record the subscription id only
    UPDATE billing_customers SET subscription_id = COALESCE(p_subscription, subscription_id), status = v_status,
      plan_key = v_plan, current_period_end = COALESCE(p_period_end, current_period_end),
      cancel_at_period_end = COALESCE(p_cancel_at_end, cancel_at_period_end), grace_until = v_grace, updated_at = now()
      WHERE tenant_id = v_t;
  ELSIF p_action = 'subscription_deleted' THEN
    UPDATE billing_customers SET status = 'canceled', subscription_id = NULL, grace_until = NULL, plan_key = 'free',
      cancel_at_period_end = false, updated_at = now() WHERE tenant_id = v_t;
    v_new_plan := 'free';
  ELSIF p_action = 'payment_failed' THEN
    UPDATE billing_customers SET status = 'past_due', grace_until = COALESCE(grace_until, now() + make_interval(days => p_grace_days)),
      updated_at = now() WHERE tenant_id = v_t AND status IN ('active','trialing','past_due');
  ELSIF p_action = 'payment_succeeded' THEN
    UPDATE billing_customers SET status = 'active', grace_until = NULL, updated_at = now() WHERE tenant_id = v_t AND status = 'past_due';
  END IF;

  IF v_new_plan IS NOT NULL THEN
    UPDATE tenants SET plan_key = v_new_plan, updated_at = now() WHERE id = v_t AND status <> 'deleted' AND plan_key <> v_new_plan;
  END IF;
  INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, metadata)
    VALUES (v_t, 'billing.' || p_action, 'tenant', v_t::text,
            jsonb_build_object('eventId', p_event_id, 'type', p_type, 'status', p_status, 'plan', p_plan));
  RETURN 'applied';
END $$;

-- Downgrade tenants whose payment grace window has expired. Returns the number of tenants downgraded.
CREATE FUNCTION billing_expire_grace() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; n integer := 0;
BEGIN
  FOR r IN SELECT b.tenant_id FROM billing_customers b JOIN tenants t ON t.id = b.tenant_id
           WHERE b.status = 'past_due' AND b.grace_until < now() AND t.plan_key <> 'free' AND t.status <> 'deleted'
           FOR UPDATE OF b LOOP
    UPDATE tenants SET plan_key = 'free', updated_at = now() WHERE id = r.tenant_id;
    INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, metadata)
      VALUES (r.tenant_id, 'billing.grace_expired', 'tenant', r.tenant_id::text, '{}'::jsonb);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- ---- usage rollup (all tenants, UTC days; idempotent) ------------------------------------------------------------
CREATE FUNCTION usage_rollup(p_from date, p_to date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer := 0; c integer;
BEGIN
  IF p_to < p_from OR p_to - p_from > 62 THEN RAISE EXCEPTION 'invalid range'; END IF;
  INSERT INTO usage_daily (tenant_id, day, metric, value)
    SELECT tenant_id, (created_at AT TIME ZONE 'UTC')::date, 'conversations', count(*) FROM conversations
    WHERE created_at >= p_from::timestamp AT TIME ZONE 'UTC' AND created_at < (p_to + 1)::timestamp AT TIME ZONE 'UTC' GROUP BY 1, 2
    ON CONFLICT (tenant_id, day, metric) DO UPDATE SET value = EXCLUDED.value;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  INSERT INTO usage_daily (tenant_id, day, metric, value)
    SELECT tenant_id, (created_at AT TIME ZONE 'UTC')::date, 'messages', count(*) FROM messages
    WHERE sender_type <> 'note' AND created_at >= p_from::timestamp AT TIME ZONE 'UTC' AND created_at < (p_to + 1)::timestamp AT TIME ZONE 'UTC' GROUP BY 1, 2
    ON CONFLICT (tenant_id, day, metric) DO UPDATE SET value = EXCLUDED.value;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  INSERT INTO usage_daily (tenant_id, day, metric, value)
    SELECT tenant_id, (created_at AT TIME ZONE 'UTC')::date, 'new_contacts', count(*) FROM contacts
    WHERE created_at >= p_from::timestamp AT TIME ZONE 'UTC' AND created_at < (p_to + 1)::timestamp AT TIME ZONE 'UTC' GROUP BY 1, 2
    ON CONFLICT (tenant_id, day, metric) DO UPDATE SET value = EXCLUDED.value;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  INSERT INTO usage_daily (tenant_id, day, metric, value)
    SELECT tenant_id, day, 'llm_tokens', sum(amount) FROM ai_usage
    WHERE day BETWEEN p_from AND p_to AND kind IN ('llm_prompt_tokens','llm_completion_tokens') GROUP BY 1, 2
    ON CONFLICT (tenant_id, day, metric) DO UPDATE SET value = EXCLUDED.value;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  RETURN n;
END $$;

-- ---- worker heartbeat ---------------------------------------------------------------------------------------------
CREATE FUNCTION worker_heartbeat(p_name text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO worker_heartbeats (name, beat_at) VALUES (left(p_name, 100), now())
  ON CONFLICT (name) DO UPDATE SET beat_at = now()
$$;

-- ---- super-admin functions -------------------------------------------------------------------------------------------
CREATE FUNCTION sa_tenant_detail(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'counts', jsonb_build_object(
      'users', (SELECT count(*) FROM users WHERE tenant_id = p_id),
      'agents', (SELECT count(*) FROM agents WHERE tenant_id = p_id AND status <> 'archived'),
      'widgets', (SELECT count(*) FROM widgets WHERE tenant_id = p_id),
      'contacts', (SELECT count(*) FROM contacts WHERE tenant_id = p_id),
      'conversations', (SELECT count(*) FROM conversations WHERE tenant_id = p_id),
      'knowledgeSources', (SELECT count(*) FROM knowledge_sources WHERE tenant_id = p_id)),
    'lastActivityAt', (SELECT max(created_at) FROM messages WHERE tenant_id = p_id),
    'billing', (SELECT to_jsonb(b) - 'tenant_id' - 'customer_id' FROM billing_customers b WHERE b.tenant_id = p_id),
    'hasCustomer', EXISTS (SELECT 1 FROM billing_customers WHERE tenant_id = p_id))
  WHERE EXISTS (SELECT 1 FROM tenants WHERE id = p_id)
$$;

CREATE FUNCTION sa_tenant_usage(p_id uuid, p_days integer) RETURNS TABLE (day date, metric text, value bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.day, u.metric, u.value FROM usage_daily u
  WHERE u.tenant_id = p_id AND u.day >= (now() AT TIME ZONE 'UTC')::date - LEAST(GREATEST(p_days, 1), 365)
  ORDER BY u.day, u.metric
$$;

CREATE FUNCTION sa_platform_analytics() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'tenants', jsonb_build_object(
      'total', (SELECT count(*) FROM tenants),
      'active', (SELECT count(*) FROM tenants WHERE status = 'active'),
      'suspended', (SELECT count(*) FROM tenants WHERE status = 'suspended'),
      'deleted', (SELECT count(*) FROM tenants WHERE status = 'deleted'),
      'new30d', (SELECT count(*) FROM tenants WHERE created_at >= now() - interval '30 days')),
    'byPlan', COALESCE((SELECT jsonb_agg(jsonb_build_object('plan', plan_key, 'count', n) ORDER BY plan_key)
                        FROM (SELECT plan_key, count(*) AS n FROM tenants WHERE status <> 'deleted' GROUP BY plan_key) x), '[]'::jsonb),
    'mrrCents', COALESCE((SELECT sum(p.monthly_cents) FROM tenants t JOIN plan_prices p ON p.plan_key = t.plan_key WHERE t.status = 'active'), 0),
    'conversations', jsonb_build_object(
      'last30d', (SELECT count(*) FROM conversations WHERE created_at >= now() - interval '30 days'),
      'perDay', COALESCE((SELECT jsonb_agg(jsonb_build_object('day', d, 'count', n) ORDER BY d)
                          FROM (SELECT (created_at AT TIME ZONE 'UTC')::date AS d, count(*) AS n FROM conversations
                                WHERE created_at >= now() - interval '30 days' GROUP BY 1) y), '[]'::jsonb)),
    'funnel', COALESCE((SELECT jsonb_agg(jsonb_build_object('stage', s.stage, 'conversations', COALESCE(f.n, 0)) ORDER BY s.ord)
                        FROM (VALUES ('visitor',1),('engaged',2),('qualified',3),('booking_offered',4),('booked',5),('handoff_requested',6)) AS s(stage, ord)
                        LEFT JOIN (SELECT to_stage, count(DISTINCT conversation_id) AS n FROM stage_transitions
                                   WHERE created_at >= now() - interval '30 days' GROUP BY to_stage) f ON f.to_stage = s.stage), '[]'::jsonb))
$$;

CREATE FUNCTION sa_system_health() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'queue', jsonb_build_object(
      'queued', (SELECT count(*) FROM jobs WHERE status = 'queued'),
      'running', (SELECT count(*) FROM jobs WHERE status = 'running'),
      'dead', (SELECT count(*) FROM jobs WHERE status = 'dead'),
      'oldestQueuedAgeSec', (SELECT floor(extract(epoch FROM now() - min(run_at)))::int FROM jobs WHERE status = 'queued' AND run_at <= now())),
    'lastHeartbeatAt', (SELECT max(beat_at) FROM worker_heartbeats),
    'heartbeatAgeSec', (SELECT floor(extract(epoch FROM now() - max(beat_at)))::int FROM worker_heartbeats))
$$;

-- status: ok | tenant_inactive | not_found | user_not_found
CREATE FUNCTION sa_start_impersonation(p_admin uuid, p_tenant uuid, p_user uuid, p_reason text, p_ttl_secs integer)
RETURNS TABLE (r_status text, r_session uuid, r_user uuid, r_role text, r_email text, r_name text, r_tenant_name text, r_expires timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t tenants%ROWTYPE; u users%ROWTYPE; v_sid uuid; v_exp timestamptz := now() + make_interval(secs => LEAST(p_ttl_secs, 900));
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
  INSERT INTO impersonation_sessions (admin_id, tenant_id, user_id, reason, expires_at) VALUES (p_admin, p_tenant, u.id, p_reason, v_exp) RETURNING id INTO v_sid;
  INSERT INTO platform_audit_logs (admin_id, action, tenant_id, metadata)
    VALUES (p_admin, 'impersonation.start', p_tenant, jsonb_build_object('sessionId', v_sid, 'userId', u.id, 'reason', p_reason));
  INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, metadata)
    VALUES (p_tenant, 'impersonation.started', 'impersonation', v_sid::text,
            jsonb_build_object('impersonatorId', p_admin, 'asUserId', u.id, 'reason', p_reason, 'expiresAt', v_exp));
  RETURN QUERY SELECT 'ok', v_sid, u.id, CASE WHEN u.role = 'owner' THEN 'admin' ELSE u.role END, u.email, u.name, t.name, v_exp;
END $$;

CREATE FUNCTION sa_end_impersonation(p_admin uuid, p_session uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s impersonation_sessions%ROWTYPE;
BEGIN
  SELECT * INTO s FROM impersonation_sessions WHERE id = p_session FOR UPDATE;
  IF NOT FOUND OR s.ended_at IS NOT NULL THEN RETURN false; END IF;
  UPDATE impersonation_sessions SET ended_at = now() WHERE id = p_session;
  INSERT INTO platform_audit_logs (admin_id, action, tenant_id, metadata)
    VALUES (p_admin, 'impersonation.end', s.tenant_id, jsonb_build_object('sessionId', p_session));
  INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, metadata)
    VALUES (s.tenant_id, 'impersonation.ended', 'impersonation', p_session::text, jsonb_build_object('impersonatorId', p_admin));
  RETURN true;
END $$;

CREATE FUNCTION sa_export_platform_audit(p_limit integer)
RETURNS TABLE (id uuid, admin_id uuid, action text, tenant_id uuid, metadata jsonb, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, admin_id, action, tenant_id, metadata, created_at FROM platform_audit_logs
  ORDER BY created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 50000)
$$;

REVOKE ALL ON FUNCTION
  billing_apply_event(text,text,text,uuid,text,text,text,text,timestamptz,boolean,integer), billing_expire_grace(), usage_rollup(date,date),
  worker_heartbeat(text), sa_tenant_detail(uuid), sa_tenant_usage(uuid,integer), sa_platform_analytics(), sa_system_health(),
  sa_start_impersonation(uuid,uuid,uuid,text,integer), sa_end_impersonation(uuid,uuid), sa_export_platform_audit(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  billing_apply_event(text,text,text,uuid,text,text,text,text,timestamptz,boolean,integer), billing_expire_grace(), usage_rollup(date,date),
  worker_heartbeat(text), sa_tenant_detail(uuid), sa_tenant_usage(uuid,integer), sa_platform_analytics(), sa_system_health(),
  sa_start_impersonation(uuid,uuid,uuid,text,integer), sa_end_impersonation(uuid,uuid), sa_export_platform_audit(integer) TO yulona_app;
