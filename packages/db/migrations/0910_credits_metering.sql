-- Wave 4 / B1: AI usage metering, micro-credits, model rates, credit packs, LLM provider profiles.
-- 1 credit = 1_000_000 micro-credits. Rates are micro-credits per 1k tokens.

-- ---- per-call usage events (tenant) ------------------------------------------------------------------
CREATE TABLE ai_usage_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  at                timestamptz NOT NULL DEFAULT now(),
  day               date NOT NULL DEFAULT (now() AT TIME ZONE 'UTC')::date,
  agent_id          uuid,
  conversation_id   uuid,
  source            text NOT NULL DEFAULT 'turn' CHECK (source IN ('turn','sandbox','builder','tool_test')),
  model             text,
  profile_id        uuid,
  prompt_tokens     integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  credits_micro     bigint NOT NULL DEFAULT 0 CHECK (credits_micro >= 0)
);
CREATE INDEX ai_usage_events_day_idx ON ai_usage_events (tenant_id, day);
CREATE INDEX ai_usage_events_agent_idx ON ai_usage_events (tenant_id, agent_id, day);
CREATE INDEX ai_usage_events_conv_idx ON ai_usage_events (tenant_id, conversation_id) WHERE conversation_id IS NOT NULL;

-- ---- platform-level pricing --------------------------------------------------------------------------
CREATE TABLE llm_model_rates (
  model                text PRIMARY KEY CHECK (char_length(model) BETWEEN 1 AND 120),
  input_micro_per_1k   bigint NOT NULL CHECK (input_micro_per_1k >= 0),
  output_micro_per_1k  bigint NOT NULL CHECK (output_micro_per_1k >= 0),
  enabled              boolean NOT NULL DEFAULT true,
  updated_at           timestamptz NOT NULL DEFAULT now()
);
INSERT INTO llm_model_rates (model, input_micro_per_1k, output_micro_per_1k) VALUES ('*', 250000, 1000000);

CREATE TABLE credit_packs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  credits     bigint NOT NULL CHECK (credits > 0 AND credits <= 10000000),
  price_cents integer NOT NULL CHECK (price_cents >= 0),
  currency    text NOT NULL DEFAULT 'usd',
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO credit_packs (name, credits, price_cents, sort_order) VALUES
  ('Starter', 500, 900, 1), ('Growth', 2500, 3900, 2), ('Scale', 10000, 12900, 3);

CREATE TABLE llm_provider_profiles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  base_url              text NOT NULL,
  auth_header           text NOT NULL DEFAULT 'Authorization',
  auth_scheme           text NOT NULL DEFAULT 'bearer' CHECK (auth_scheme IN ('bearer','raw','none')),
  extra_headers         jsonb NOT NULL DEFAULT '{}'::jsonb,
  query_params          jsonb NOT NULL DEFAULT '{}'::jsonb,
  chat_path             text NOT NULL DEFAULT '/chat/completions',
  credentials_encrypted text,
  default_model         text NOT NULL,
  enabled_models        text[] NOT NULL DEFAULT '{}',
  is_default            boolean NOT NULL DEFAULT false,
  enabled               boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX llm_provider_profiles_name_uniq ON llm_provider_profiles (lower(name));
CREATE UNIQUE INDEX llm_provider_profiles_one_default ON llm_provider_profiles (is_default) WHERE is_default;

-- ---- tenant credits ----------------------------------------------------------------------------------
CREATE TABLE tenant_credits (
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  period               date NOT NULL,                    -- first day of the UTC month
  allowance_micro      bigint,                           -- NULL = unlimited plan
  used_micro           bigint NOT NULL DEFAULT 0,        -- consumed from the allowance
  topup_micro          bigint NOT NULL DEFAULT 0,        -- remaining top-up balance (carries over; may dip negative on overshoot)
  topup_used_micro     bigint NOT NULL DEFAULT 0,        -- consumed from top-ups this period
  warned_80_at         timestamptz,
  exhausted_notified_at timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period)
);

CREATE TABLE credit_topups (
  ref          text PRIMARY KEY,                         -- provider checkout session id (idempotency key)
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  pack_id      uuid,
  credits_micro bigint NOT NULL CHECK (credits_micro > 0),
  amount_cents integer,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_topups_tenant_idx ON credit_topups (tenant_id, created_at DESC);

-- ---- plan limit + rollup metrics ----------------------------------------------------------------------
ALTER TABLE plan_limits DROP CONSTRAINT plan_limits_metric_check;
ALTER TABLE plan_limits ADD CONSTRAINT plan_limits_metric_check
  CHECK (metric IN ('seats','agents','widgets','api_keys','monthly_conversations','storage_mb','llm_tokens_monthly','llm_credits_monthly'));
INSERT INTO plan_limits (plan_key, metric, limit_value) VALUES
  ('free','llm_credits_monthly',50), ('pro','llm_credits_monthly',1500),
  ('enterprise','llm_credits_monthly',NULL), ('self_hosted','llm_credits_monthly',NULL);

ALTER TABLE usage_daily DROP CONSTRAINT usage_daily_metric_check;
ALTER TABLE usage_daily ADD CONSTRAINT usage_daily_metric_check
  CHECK (metric IN ('conversations','messages','llm_tokens','new_contacts','credits','llm_requests'));

-- ---- RLS ----------------------------------------------------------------------------------------------
DO $$
DECLARE t text; owner_role text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_usage_events','tenant_credits','credit_topups'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, owner_role);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO yulona_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
  -- secrets live here: owner only, the app role reaches it through definer functions
  EXECUTE 'ALTER TABLE llm_provider_profiles ENABLE ROW LEVEL SECURITY';
  EXECUTE 'ALTER TABLE llm_provider_profiles FORCE ROW LEVEL SECURITY';
  EXECUTE format('CREATE POLICY owner_all ON llm_provider_profiles FOR ALL TO %I USING (true) WITH CHECK (true)', owner_role);
END $$;
GRANT SELECT, INSERT ON ai_usage_events TO yulona_app;
GRANT SELECT, INSERT, UPDATE ON tenant_credits TO yulona_app;
GRANT SELECT ON credit_topups, llm_model_rates, credit_packs TO yulona_app;

-- ---- credits engine (SECURITY INVOKER: runs inside withTenant, RLS applies) ------------------------------
CREATE FUNCTION credits_period_start() RETURNS date LANGUAGE sql STABLE AS $$
  SELECT date_trunc('month', now() AT TIME ZONE 'UTC')::date
$$;

CREATE FUNCTION credits_plan_allowance(p_tenant uuid) RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT pl.limit_value * 1000000 FROM tenants t
  LEFT JOIN plan_limits pl ON pl.plan_key = t.plan_key AND pl.metric = 'llm_credits_monthly'
  WHERE t.id = p_tenant
$$;

-- Ensure this month's row exists (carrying over the top-up balance) and refresh the allowance from the plan.
CREATE FUNCTION credits_sync(p_tenant uuid) RETURNS tenant_credits LANGUAGE plpgsql AS $$
DECLARE v_period date := credits_period_start(); v_allow bigint := credits_plan_allowance(p_tenant); r tenant_credits;
BEGIN
  INSERT INTO tenant_credits (tenant_id, period, allowance_micro, topup_micro)
  VALUES (p_tenant, v_period, v_allow,
          COALESCE((SELECT topup_micro FROM tenant_credits WHERE tenant_id = p_tenant AND period < v_period ORDER BY period DESC LIMIT 1), 0))
  ON CONFLICT (tenant_id, period) DO NOTHING;
  UPDATE tenant_credits SET allowance_micro = v_allow, updated_at = now()
    WHERE tenant_id = p_tenant AND period = v_period AND allowance_micro IS DISTINCT FROM v_allow;
  SELECT * INTO r FROM tenant_credits WHERE tenant_id = p_tenant AND period = v_period;
  RETURN r;
END $$;

-- remaining = (allowance - used) + topup; NULL when the plan is unlimited
CREATE FUNCTION credits_remaining_of(r tenant_credits) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN r.allowance_micro IS NULL THEN NULL ELSE r.allowance_micro - r.used_micro + r.topup_micro END
$$;

-- Notify owners/admins once per period for each threshold.
CREATE FUNCTION credits_check_notify(p_tenant uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r tenant_credits; v_rem bigint; v_pool numeric; v_pct numeric; u record; v_kind text; v_title text; v_body text; v_hit boolean := false;
BEGIN
  SELECT * INTO r FROM tenant_credits WHERE tenant_id = p_tenant AND period = credits_period_start();
  IF NOT FOUND OR r.allowance_micro IS NULL THEN RETURN; END IF;
  v_rem := credits_remaining_of(r);
  v_pool := r.allowance_micro + r.topup_used_micro + GREATEST(r.topup_micro, 0);
  v_pct := CASE WHEN v_pool > 0 THEN (r.used_micro + r.topup_used_micro) * 100.0 / v_pool ELSE 100 END;
  IF v_rem <= 0 THEN
    UPDATE tenant_credits SET exhausted_notified_at = now() WHERE tenant_id = p_tenant AND period = r.period AND exhausted_notified_at IS NULL;
    v_hit := FOUND; v_kind := 'credits.exhausted';
    v_title := 'AI credits used up'; v_body := 'Your AI credits for this period are used up. The assistant hands conversations to your team until you buy more credits or the period resets.';
  ELSIF v_pct >= 80 THEN
    UPDATE tenant_credits SET warned_80_at = now() WHERE tenant_id = p_tenant AND period = r.period AND warned_80_at IS NULL;
    v_hit := FOUND; v_kind := 'credits.warning_80';
    v_title := 'AI credits 80% used'; v_body := 'You have used 80% of your AI credits for this period. Buy more credits to avoid interruption.';
  END IF;
  IF v_hit THEN
    FOR u IN SELECT id FROM users WHERE tenant_id = p_tenant AND status = 'active' AND role IN ('owner','admin') LOOP
      PERFORM ops_notify(p_tenant, u.id, v_kind, v_title, v_body, jsonb_build_object('period', r.period, 'remainingMicro', v_rem), true);
    END LOOP;
  END IF;
END $$;

-- Atomic consumption: monthly allowance first, then top-up. Row lock serializes concurrent callers.
CREATE FUNCTION consume_credits(p_tenant uuid, p_micro bigint) RETURNS tenant_credits LANGUAGE plpgsql AS $$
DECLARE r tenant_credits; v_from_allow bigint;
BEGIN
  PERFORM credits_sync(p_tenant);
  SELECT * INTO r FROM tenant_credits WHERE tenant_id = p_tenant AND period = credits_period_start() FOR UPDATE;
  IF p_micro > 0 THEN
    v_from_allow := CASE WHEN r.allowance_micro IS NULL THEN p_micro ELSE LEAST(p_micro, GREATEST(r.allowance_micro - r.used_micro, 0)) END;
    UPDATE tenant_credits SET used_micro = used_micro + v_from_allow,
           topup_micro = topup_micro - (p_micro - v_from_allow),
           topup_used_micro = topup_used_micro + (p_micro - v_from_allow), updated_at = now()
      WHERE tenant_id = p_tenant AND period = r.period RETURNING * INTO r;
    PERFORM credits_check_notify(p_tenant);
  END IF;
  RETURN r;
END $$;

-- Gate: remaining credits (NULL = unlimited). Also fires the exhausted notice if the gate is the first to notice.
CREATE FUNCTION credits_gate(p_tenant uuid) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE r tenant_credits;
BEGIN
  r := credits_sync(p_tenant);
  IF r.allowance_micro IS NOT NULL AND credits_remaining_of(r) <= 0 THEN PERFORM credits_check_notify(p_tenant); END IF;
  RETURN credits_remaining_of(r);
END $$;

-- ---- cross-tenant functions (definer) ------------------------------------------------------------------------
-- Stripe/webhook top-up, idempotent on `p_ref`. Returns applied | duplicate | unknown_tenant.
CREATE FUNCTION credits_apply_topup(p_ref text, p_tenant uuid, p_pack uuid, p_micro bigint, p_amount_cents integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u record;
BEGIN
  IF p_micro IS NULL OR p_micro <= 0 THEN RETURN 'unknown_tenant'; END IF;
  IF p_tenant IS NULL OR NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant AND status <> 'deleted') THEN RETURN 'unknown_tenant'; END IF;
  INSERT INTO credit_topups (ref, tenant_id, pack_id, credits_micro, amount_cents)
    VALUES (left(p_ref, 200), p_tenant, p_pack, p_micro, p_amount_cents) ON CONFLICT (ref) DO NOTHING;
  IF NOT FOUND THEN RETURN 'duplicate'; END IF;
  PERFORM credits_sync(p_tenant);
  UPDATE tenant_credits SET topup_micro = topup_micro + p_micro, updated_at = now() WHERE tenant_id = p_tenant AND period = credits_period_start();
  INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, metadata)
    VALUES (p_tenant, 'billing.credits_purchased', 'tenant', p_tenant::text, jsonb_build_object('packId', p_pack, 'creditsMicro', p_micro, 'amountCents', p_amount_cents));
  FOR u IN SELECT id FROM users WHERE tenant_id = p_tenant AND status = 'active' AND role IN ('owner','admin') LOOP
    PERFORM ops_notify(p_tenant, u.id, 'credits.purchased', 'AI credits added', 'Your credit purchase was received and the credits are available now.',
                       jsonb_build_object('creditsMicro', p_micro), false);
  END LOOP;
  RETURN 'applied';
END $$;

-- Worker: open the new period's row (carrying top-ups) for tenants that had one last period.
CREATE FUNCTION credits_rollover() RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n integer;
BEGIN
  INSERT INTO tenant_credits (tenant_id, period, allowance_micro, topup_micro)
  SELECT p.tenant_id, credits_period_start(), credits_plan_allowance(p.tenant_id), p.topup_micro
  FROM (SELECT DISTINCT ON (tenant_id) tenant_id, period, topup_micro FROM tenant_credits ORDER BY tenant_id, period DESC) p
  JOIN tenants t ON t.id = p.tenant_id AND t.status <> 'deleted'
  WHERE p.period < credits_period_start()
  ON CONFLICT (tenant_id, period) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- ---- super-admin functions (all write platform_audit_logs) ---------------------------------------------------------
CREATE FUNCTION sa_set_model_rate(p_admin uuid, p_model text, p_in bigint, p_out bigint, p_enabled boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO llm_model_rates (model, input_micro_per_1k, output_micro_per_1k, enabled) VALUES (p_model, p_in, p_out, COALESCE(p_enabled, true))
  ON CONFLICT (model) DO UPDATE SET input_micro_per_1k = EXCLUDED.input_micro_per_1k, output_micro_per_1k = EXCLUDED.output_micro_per_1k,
    enabled = EXCLUDED.enabled, updated_at = now();
  INSERT INTO platform_audit_logs (admin_id, action, metadata)
    VALUES (p_admin, 'model_rate.set', jsonb_build_object('model', p_model, 'inputMicroPer1k', p_in, 'outputMicroPer1k', p_out, 'enabled', COALESCE(p_enabled, true)));
END $$;

CREATE FUNCTION sa_delete_model_rate(p_admin uuid, p_model text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_model = '*' THEN RAISE EXCEPTION 'default rate cannot be deleted' USING ERRCODE = '22023'; END IF;
  DELETE FROM llm_model_rates WHERE model = p_model;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO platform_audit_logs (admin_id, action, metadata) VALUES (p_admin, 'model_rate.delete', jsonb_build_object('model', p_model));
  RETURN true;
END $$;

CREATE FUNCTION sa_upsert_credit_pack(p_admin uuid, p_id uuid, p_name text, p_credits bigint, p_price integer, p_active boolean, p_sort integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF p_id IS NULL THEN
    INSERT INTO credit_packs (name, credits, price_cents, active, sort_order) VALUES (p_name, p_credits, p_price, COALESCE(p_active, true), COALESCE(p_sort, 0))
      RETURNING id INTO v_id;
  ELSE
    UPDATE credit_packs SET name = p_name, credits = p_credits, price_cents = p_price, active = COALESCE(p_active, active), sort_order = COALESCE(p_sort, sort_order)
      WHERE id = p_id RETURNING id INTO v_id;
    IF v_id IS NULL THEN RETURN NULL; END IF;
  END IF;
  INSERT INTO platform_audit_logs (admin_id, action, metadata)
    VALUES (p_admin, 'credit_pack.upsert', jsonb_build_object('id', v_id, 'name', p_name, 'credits', p_credits, 'priceCents', p_price));
  RETURN v_id;
END $$;

-- Hard delete when never purchased, else deactivate (purchase history keeps the row). Returns deleted | deactivated | missing.
CREATE FUNCTION sa_delete_credit_pack(p_admin uuid, p_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_res text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM credit_packs WHERE id = p_id) THEN RETURN 'missing'; END IF;
  IF EXISTS (SELECT 1 FROM credit_topups WHERE pack_id = p_id) THEN
    UPDATE credit_packs SET active = false WHERE id = p_id; v_res := 'deactivated';
  ELSE
    DELETE FROM credit_packs WHERE id = p_id; v_res := 'deleted';
  END IF;
  INSERT INTO platform_audit_logs (admin_id, action, metadata) VALUES (p_admin, 'credit_pack.delete', jsonb_build_object('id', p_id, 'result', v_res));
  RETURN v_res;
END $$;

-- Grant (or deduct, negative) credits to a tenant's top-up balance.
CREATE FUNCTION sa_grant_credits(p_admin uuid, p_tenant uuid, p_micro bigint, p_reason text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE u record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant AND status <> 'deleted') THEN RETURN false; END IF;
  PERFORM credits_sync(p_tenant);
  UPDATE tenant_credits SET topup_micro = topup_micro + p_micro, updated_at = now() WHERE tenant_id = p_tenant AND period = credits_period_start();
  INSERT INTO platform_audit_logs (admin_id, action, tenant_id, metadata)
    VALUES (p_admin, 'credits.grant', p_tenant, jsonb_build_object('creditsMicro', p_micro, 'reason', left(p_reason, 300)));
  INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, metadata)
    VALUES (p_tenant, 'billing.credits_adjusted', 'tenant', p_tenant::text, jsonb_build_object('creditsMicro', p_micro));
  IF p_micro > 0 THEN
    FOR u IN SELECT id FROM users WHERE tenant_id = p_tenant AND status = 'active' AND role IN ('owner','admin') LOOP
      PERFORM ops_notify(p_tenant, u.id, 'credits.granted', 'AI credits added', 'Credits were added to your workspace.', jsonb_build_object('creditsMicro', p_micro), false);
    END LOOP;
  END IF;
  RETURN true;
END $$;

-- Tenant credits for the admin console (does not require a tenant context).
CREATE FUNCTION sa_tenant_credits(p_tenant uuid) RETURNS TABLE (
  plan_key text, period date, allowance_micro bigint, used_micro bigint, topup_micro bigint, topup_used_micro bigint
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r tenant_credits; v_plan text;
BEGIN
  SELECT t.plan_key INTO v_plan FROM tenants t WHERE t.id = p_tenant;
  IF v_plan IS NULL THEN RETURN; END IF;
  r := credits_sync(p_tenant);
  RETURN QUERY SELECT v_plan, r.period, r.allowance_micro, r.used_micro, r.topup_micro, r.topup_used_micro;
END $$;

-- ---- LLM provider profiles (credentials only ever leave through llm_profile_resolve) --------------------------------
CREATE FUNCTION sa_list_llm_profiles() RETURNS TABLE (
  id uuid, name text, base_url text, auth_header text, auth_scheme text, extra_headers jsonb, query_params jsonb, chat_path text,
  default_model text, enabled_models text[], is_default boolean, enabled boolean, has_credentials boolean, created_at timestamptz, updated_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, name, base_url, auth_header, auth_scheme, extra_headers, query_params, chat_path, default_model, enabled_models,
         is_default, enabled, credentials_encrypted IS NOT NULL, created_at, updated_at
  FROM llm_provider_profiles ORDER BY created_at, id
$$;

CREATE FUNCTION sa_create_llm_profile(
  p_admin uuid, p_id uuid, p_name text, p_base_url text, p_auth_header text, p_auth_scheme text, p_extra text, p_query text,
  p_chat_path text, p_creds text, p_default_model text, p_models text[], p_is_default boolean, p_enabled boolean
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_is_default AND COALESCE(p_enabled, true) THEN UPDATE llm_provider_profiles SET is_default = false WHERE is_default; END IF;
  INSERT INTO llm_provider_profiles (id, name, base_url, auth_header, auth_scheme, extra_headers, query_params, chat_path, credentials_encrypted,
                                     default_model, enabled_models, is_default, enabled)
  VALUES (p_id, p_name, p_base_url, p_auth_header, p_auth_scheme, p_extra::jsonb, p_query::jsonb, p_chat_path, p_creds,
          p_default_model, COALESCE(p_models, '{}'), p_is_default AND COALESCE(p_enabled, true), COALESCE(p_enabled, true));
  INSERT INTO platform_audit_logs (admin_id, action, metadata)
    VALUES (p_admin, 'llm_profile.create', jsonb_build_object('id', p_id, 'name', p_name, 'baseUrl', p_base_url, 'hasCredentials', p_creds IS NOT NULL));
  RETURN p_id;
END $$;

-- p_patch carries only the fields to change (camelCase); credentials are passed separately.
CREATE FUNCTION sa_update_llm_profile(p_admin uuid, p_id uuid, p_patch text, p_set_creds boolean, p_creds text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE j jsonb := p_patch::jsonb; v_default boolean; v_enabled boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM llm_provider_profiles WHERE id = p_id) THEN RETURN false; END IF;
  SELECT CASE WHEN j ? 'isDefault' THEN (j->>'isDefault')::boolean ELSE is_default END,
         CASE WHEN j ? 'enabled' THEN (j->>'enabled')::boolean ELSE enabled END
    INTO v_default, v_enabled FROM llm_provider_profiles WHERE id = p_id;
  v_default := v_default AND v_enabled;
  IF v_default THEN UPDATE llm_provider_profiles SET is_default = false WHERE is_default AND id <> p_id; END IF;
  UPDATE llm_provider_profiles SET
    name = CASE WHEN j ? 'name' THEN j->>'name' ELSE name END,
    base_url = CASE WHEN j ? 'baseUrl' THEN j->>'baseUrl' ELSE base_url END,
    auth_header = CASE WHEN j ? 'authHeader' THEN j->>'authHeader' ELSE auth_header END,
    auth_scheme = CASE WHEN j ? 'authScheme' THEN j->>'authScheme' ELSE auth_scheme END,
    extra_headers = CASE WHEN j ? 'extraHeaders' THEN j->'extraHeaders' ELSE extra_headers END,
    query_params = CASE WHEN j ? 'queryParams' THEN j->'queryParams' ELSE query_params END,
    chat_path = CASE WHEN j ? 'chatPath' THEN j->>'chatPath' ELSE chat_path END,
    default_model = CASE WHEN j ? 'defaultModel' THEN j->>'defaultModel' ELSE default_model END,
    enabled_models = CASE WHEN j ? 'enabledModels' THEN ARRAY(SELECT jsonb_array_elements_text(j->'enabledModels')) ELSE enabled_models END,
    credentials_encrypted = CASE WHEN p_set_creds THEN p_creds ELSE credentials_encrypted END,
    is_default = v_default, enabled = v_enabled, updated_at = now()
  WHERE id = p_id;
  INSERT INTO platform_audit_logs (admin_id, action, metadata)
    VALUES (p_admin, 'llm_profile.update', jsonb_build_object('id', p_id, 'fields', (SELECT COALESCE(jsonb_agg(k), '[]'::jsonb) FROM jsonb_object_keys(j) k),
                                                              'credentialsChanged', p_set_creds));
  RETURN true;
END $$;

CREATE FUNCTION sa_delete_llm_profile(p_admin uuid, p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM llm_provider_profiles WHERE id = p_id;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO platform_audit_logs (admin_id, action, metadata) VALUES (p_admin, 'llm_profile.delete', jsonb_build_object('id', p_id));
  RETURN true;
END $$;

-- Credentials + settings of one profile for the admin "test" button and the runtime resolver. p_id NULL = the default one.
CREATE FUNCTION llm_profile_resolve(p_id uuid) RETURNS TABLE (
  id uuid, name text, base_url text, auth_header text, auth_scheme text, extra_headers jsonb, query_params jsonb, chat_path text,
  credentials_encrypted text, default_model text, enabled_models text[]
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, name, base_url, auth_header, auth_scheme, extra_headers, query_params, chat_path, credentials_encrypted, default_model, enabled_models
  FROM llm_provider_profiles
  WHERE CASE WHEN p_id IS NULL THEN is_default AND enabled ELSE id = p_id END
  LIMIT 1
$$;

-- ---- usage_rollup: add credits + llm_requests -------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION usage_rollup(p_from date, p_to date) RETURNS integer
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
  INSERT INTO usage_daily (tenant_id, day, metric, value)
    SELECT tenant_id, day, 'llm_requests', sum(amount) FROM ai_usage
    WHERE day BETWEEN p_from AND p_to AND kind = 'llm_requests' GROUP BY 1, 2
    ON CONFLICT (tenant_id, day, metric) DO UPDATE SET value = EXCLUDED.value;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  INSERT INTO usage_daily (tenant_id, day, metric, value)
    SELECT tenant_id, day, 'credits', sum(credits_micro) FROM ai_usage_events
    WHERE day BETWEEN p_from AND p_to GROUP BY 1, 2
    ON CONFLICT (tenant_id, day, metric) DO UPDATE SET value = EXCLUDED.value;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  RETURN n;
END $$;

-- ---- grants -----------------------------------------------------------------------------------------------------------
REVOKE ALL ON FUNCTION
  credits_apply_topup(text,uuid,uuid,bigint,integer), credits_rollover(),
  sa_set_model_rate(uuid,text,bigint,bigint,boolean), sa_delete_model_rate(uuid,text),
  sa_upsert_credit_pack(uuid,uuid,text,bigint,integer,boolean,integer), sa_delete_credit_pack(uuid,uuid),
  sa_grant_credits(uuid,uuid,bigint,text), sa_tenant_credits(uuid),
  sa_list_llm_profiles(), sa_create_llm_profile(uuid,uuid,text,text,text,text,text,text,text,text,text,text[],boolean,boolean),
  sa_update_llm_profile(uuid,uuid,text,boolean,text), sa_delete_llm_profile(uuid,uuid), llm_profile_resolve(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  credits_apply_topup(text,uuid,uuid,bigint,integer), credits_rollover(),
  sa_set_model_rate(uuid,text,bigint,bigint,boolean), sa_delete_model_rate(uuid,text),
  sa_upsert_credit_pack(uuid,uuid,text,bigint,integer,boolean,integer), sa_delete_credit_pack(uuid,uuid),
  sa_grant_credits(uuid,uuid,bigint,text), sa_tenant_credits(uuid),
  sa_list_llm_profiles(), sa_create_llm_profile(uuid,uuid,text,text,text,text,text,text,text,text,text,text[],boolean,boolean),
  sa_update_llm_profile(uuid,uuid,text,boolean,text), sa_delete_llm_profile(uuid,uuid), llm_profile_resolve(uuid)
TO yulona_app;
GRANT EXECUTE ON FUNCTION
  credits_period_start(), credits_plan_allowance(uuid), credits_sync(uuid), credits_remaining_of(tenant_credits),
  credits_check_notify(uuid), consume_credits(uuid,bigint), credits_gate(uuid)
TO yulona_app;
