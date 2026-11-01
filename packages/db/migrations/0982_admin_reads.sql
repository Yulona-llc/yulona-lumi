-- Customer-360 read functions for the platform-admin service (SECURITY DEFINER, STABLE, explicit column lists).
-- Rules: never return message text, contact name/email/phone/attributes, secrets or ciphertext. Grants in 0990.

-- ---- health score ----------------------------------------------------------------------------------------------
-- score = 100 - penalties; bucket healthy (>=80) / watch (50-79) / at_risk (<50); reasons sorted by points desc.
CREATE FUNCTION sa_health_scores(p_tenant uuid DEFAULT NULL)
RETURNS TABLE (tenant_id uuid, score integer, bucket text, reasons jsonb, error_count_7d integer, last_active_at timestamptz,
               credits_state text, credits_remaining_micro bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
WITH t AS (SELECT id, created_at, plan_key FROM tenants WHERE p_tenant IS NULL OR id = p_tenant),
 j  AS (SELECT x.tenant_id, count(*)::int n FROM jobs x WHERE x.status = 'dead' AND x.updated_at > now() - interval '7 days' AND (p_tenant IS NULL OR x.tenant_id = p_tenant) GROUP BY 1),
 w  AS (SELECT x.tenant_id, count(*)::int n FROM webhook_deliveries x WHERE x.status = 'failed' AND x.created_at > now() - interval '7 days' AND (p_tenant IS NULL OR x.tenant_id = p_tenant) GROUP BY 1),
 cc AS (SELECT x.tenant_id, count(*)::int n FROM channel_connections x WHERE (x.status = 'error' OR x.last_health_ok = false) AND (p_tenant IS NULL OR x.tenant_id = p_tenant) GROUP BY 1),
 cd AS (SELECT x.tenant_id, count(*)::int n FROM channel_deliveries x WHERE x.status = 'failed' AND x.created_at > now() - interval '7 days' AND (p_tenant IS NULL OR x.tenant_id = p_tenant) GROUP BY 1),
 ki AS (SELECT x.tenant_id, count(*)::int n FROM knowledge_sources x WHERE x.status = 'failed' AND x.updated_at > now() - interval '7 days' AND (p_tenant IS NULL OR x.tenant_id = p_tenant) GROUP BY 1),
 nf AS (SELECT x.tenant_id, count(*)::int n FROM notifications x WHERE x.email_status = 'failed' AND x.created_at > now() - interval '7 days' AND (p_tenant IS NULL OR x.tenant_id = p_tenant) GROUP BY 1),
 cr AS (SELECT x.tenant_id, count(*)::int n FROM crm_sync_log x WHERE x.status = 'failed' AND x.created_at > now() - interval '7 days' AND (p_tenant IS NULL OR x.tenant_id = p_tenant) GROUP BY 1),
 hf AS (SELECT x.tenant_id, count(*)::int n FROM handoffs x WHERE x.type = 'system_failure' AND x.created_at > now() - interval '7 days' AND (p_tenant IS NULL OR x.tenant_id = p_tenant) GROUP BY 1),
 tf AS (SELECT x.tenant_id, count(*)::int n FROM tool_executions x WHERE x.success = false AND x.created_at > now() - interval '7 days' AND (p_tenant IS NULL OR x.tenant_id = p_tenant) GROUP BY 1),
 ab AS (SELECT x.tenant_id, count(*)::int n FROM contacts x WHERE x.blocked_at > now() - interval '7 days' AND (p_tenant IS NULL OR x.tenant_id = p_tenant) GROUP BY 1),
 la AS (SELECT x.tenant_id, max(x.last_message_at) at FROM conversations x WHERE p_tenant IS NULL OR x.tenant_id = p_tenant GROUP BY 1),
 lu AS (SELECT x.tenant_id, max(x.last_login_at) at FROM users x WHERE p_tenant IS NULL OR x.tenant_id = p_tenant GROUP BY 1),
 ag AS (SELECT x.tenant_id, count(*)::int total, count(*) FILTER (WHERE x.published_version IS NOT NULL)::int published
        FROM agents x WHERE x.status <> 'archived' AND (p_tenant IS NULL OR x.tenant_id = p_tenant) GROUP BY 1),
 pay AS (SELECT x.tenant_id FROM billing_customers x WHERE x.status = 'past_due' AND (p_tenant IS NULL OR x.tenant_id = p_tenant)),
 cred AS (
   SELECT t.id AS tenant_id,
          CASE WHEN c.tenant_id IS NOT NULL THEN c.allowance_micro ELSE pl.limit_value * 1000000 END AS allowance,
          COALESCE(c.used_micro, 0) AS used, COALESCE(c.topup_micro, 0) AS topup
   FROM t LEFT JOIN tenant_credits c ON c.tenant_id = t.id AND c.period = date_trunc('month', now() AT TIME ZONE 'UTC')::date
          LEFT JOIN plan_limits pl ON pl.plan_key = t.plan_key AND pl.metric = 'llm_credits_monthly'),
 base AS (
   SELECT t.id, t.created_at,
     COALESCE(j.n, 0) jn, COALESCE(w.n, 0) wn, COALESCE(cc.n, 0) ccn, COALESCE(cd.n, 0) cdn, COALESCE(ki.n, 0) kin,
     COALESCE(nf.n, 0) nfn, COALESCE(cr.n, 0) crn, COALESCE(hf.n, 0) hfn, COALESCE(tf.n, 0) tfn, COALESCE(ab.n, 0) abn,
     GREATEST(la.at, lu.at) AS last_active,
     COALESCE(ag.total, 0) agt, COALESCE(ag.published, 0) agp,
     EXISTS (SELECT 1 FROM pay WHERE pay.tenant_id = t.id) AS past_due,
     CASE WHEN cred.allowance IS NULL THEN 'unlimited'
          WHEN cred.allowance - cred.used + cred.topup <= 0 THEN 'exhausted'
          WHEN (cred.allowance - cred.used + cred.topup) * 10 < cred.allowance + GREATEST(cred.topup, 0) THEN 'low'
          ELSE 'ok' END AS cstate,
     CASE WHEN cred.allowance IS NULL THEN NULL ELSE cred.allowance - cred.used + cred.topup END AS cremaining
   FROM t LEFT JOIN j ON j.tenant_id = t.id LEFT JOIN w ON w.tenant_id = t.id LEFT JOIN cc ON cc.tenant_id = t.id LEFT JOIN cd ON cd.tenant_id = t.id
     LEFT JOIN ki ON ki.tenant_id = t.id LEFT JOIN nf ON nf.tenant_id = t.id LEFT JOIN cr ON cr.tenant_id = t.id LEFT JOIN hf ON hf.tenant_id = t.id
     LEFT JOIN tf ON tf.tenant_id = t.id LEFT JOIN ab ON ab.tenant_id = t.id LEFT JOIN la ON la.tenant_id = t.id LEFT JOIN lu ON lu.tenant_id = t.id
     LEFT JOIN ag ON ag.tenant_id = t.id LEFT JOIN cred ON cred.tenant_id = t.id),
 pen AS (
   SELECT b.*,
     LEAST(20, 5 * jn) AS p_jobs, LEAST(15, 3 * wn) AS p_wh, LEAST(20, 10 * ccn + 2 * cdn) AS p_ch, LEAST(10, 5 * kin) AS p_ki,
     CASE cstate WHEN 'exhausted' THEN 25 WHEN 'low' THEN 10 ELSE 0 END AS p_cr,
     CASE WHEN past_due THEN 25 ELSE 0 END AS p_pay,
     CASE WHEN created_at < now() - interval '14 days' AND COALESCE(last_active, created_at) < now() - interval '14 days' THEN 15 ELSE 0 END AS p_in,
     CASE WHEN agt > 0 AND agp = 0 AND created_at < now() - interval '3 days' THEN 10 ELSE 0 END AS p_ag,
     LEAST(10, 2 * abn) AS p_ab
   FROM base b)
SELECT p.id,
  GREATEST(0, 100 - (p.p_jobs + p.p_wh + p.p_ch + p.p_ki + p.p_cr + p.p_pay + p.p_in + p.p_ag + p.p_ab))::int,
  CASE WHEN 100 - (p.p_jobs + p.p_wh + p.p_ch + p.p_ki + p.p_cr + p.p_pay + p.p_in + p.p_ag + p.p_ab) >= 80 THEN 'healthy'
       WHEN 100 - (p.p_jobs + p.p_wh + p.p_ch + p.p_ki + p.p_cr + p.p_pay + p.p_in + p.p_ag + p.p_ab) >= 50 THEN 'watch' ELSE 'at_risk' END,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('code', r.code, 'label', r.label, 'points', r.pts) ORDER BY r.pts DESC, r.code)
            FROM (VALUES
              ('failed_jobs', format('%s failed background jobs in 7 days', p.jn), p.p_jobs),
              ('failed_webhooks', format('%s failed webhook deliveries in 7 days', p.wn), p.p_wh),
              ('channel_errors', format('%s channel connection errors, %s failed deliveries in 7 days', p.ccn, p.cdn), p.p_ch),
              ('failed_ingests', format('%s failed knowledge ingests in 7 days', p.kin), p.p_ki),
              ('credits_exhausted', 'AI credits exhausted', CASE WHEN p.cstate = 'exhausted' THEN p.p_cr ELSE 0 END),
              ('credits_low', 'Less than 10% of AI credits left', CASE WHEN p.cstate = 'low' THEN p.p_cr ELSE 0 END),
              ('payment_failed', 'Latest payment failed', p.p_pay),
              ('inactive', 'No activity for 14+ days', p.p_in),
              ('no_published_agent', 'No agent has ever been published', p.p_ag),
              ('abuse_blocks', format('%s contacts blocked for abuse in 7 days', p.abn), p.p_ab)
            ) AS r(code, label, pts) WHERE r.pts > 0), '[]'::jsonb),
  (p.jn + p.wn + p.ccn + p.cdn + p.kin + p.nfn + p.crn + p.hfn + p.tfn)::int,
  p.last_active, p.cstate, p.cremaining
FROM pen p
$$;

-- ---- customers list v2 ----------------------------------------------------------------------------------------
CREATE FUNCTION sa_list_tenants_v2(
  p_q text, p_status text, p_plan text, p_health text, p_created_from date, p_created_to date, p_inactive_days integer,
  p_has_errors boolean, p_credits text, p_tag text, p_sort text, p_order text, p_limit integer, p_offset integer)
RETURNS TABLE (id uuid, name text, status text, plan_key text, deleted_at timestamptz, created_at timestamptz, user_count bigint, owner_email text,
  last_active_at timestamptz, error_count_7d integer, credits_state text, credits_remaining_micro bigint, health_score integer, health_bucket text,
  health_reasons jsonb, tags text[], total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
WITH q AS (SELECT CASE WHEN p_q IS NULL OR btrim(p_q) = '' THEN NULL ELSE replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') END AS s),
f AS (
  SELECT t.id, t.name, t.status, t.plan_key, t.deleted_at, t.created_at,
    (SELECT count(*) FROM users u WHERE u.tenant_id = t.id) AS user_count,
    (SELECT u.email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner' ORDER BY (u.status = 'active') DESC, u.created_at LIMIT 1) AS owner_email,
    h.last_active_at, h.error_count_7d, h.credits_state, h.credits_remaining_micro, h.score AS health_score, h.bucket AS health_bucket, h.reasons AS health_reasons,
    COALESCE((SELECT array_agg(g.tag ORDER BY g.tag) FROM tenant_tags g WHERE g.tenant_id = t.id), '{}') AS tags
  FROM tenants t JOIN sa_health_scores(NULL) h ON h.tenant_id = t.id, q
  WHERE (q.s IS NULL OR t.name ILIKE '%' || q.s || '%' OR t.id::text ILIKE q.s || '%'
         OR EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.email ILIKE '%' || q.s || '%'))
    AND (p_status IS NULL OR t.status = p_status)
    AND (p_plan IS NULL OR t.plan_key = p_plan)
    AND (p_health IS NULL OR h.bucket = p_health)
    AND (p_created_from IS NULL OR t.created_at >= p_created_from::timestamp AT TIME ZONE 'UTC')
    AND (p_created_to IS NULL OR t.created_at < (p_created_to + 1)::timestamp AT TIME ZONE 'UTC')
    AND (p_inactive_days IS NULL OR COALESCE(h.last_active_at, t.created_at) < now() - make_interval(days => p_inactive_days))
    AND (p_has_errors IS NULL OR (h.error_count_7d > 0) = p_has_errors)
    AND (p_credits IS NULL OR h.credits_state = p_credits)
    AND (p_tag IS NULL OR EXISTS (SELECT 1 FROM tenant_tags g WHERE g.tenant_id = t.id AND g.tag = p_tag))
)
SELECT f.id, f.name, f.status, f.plan_key, f.deleted_at, f.created_at, f.user_count, f.owner_email, f.last_active_at, f.error_count_7d, f.credits_state,
  f.credits_remaining_micro, f.health_score, f.health_bucket, f.health_reasons, f.tags, count(*) OVER ()
FROM f
ORDER BY
  CASE WHEN p_order = 'asc' THEN CASE p_sort WHEN 'name' THEN lower(f.name) END END ASC NULLS LAST,
  CASE WHEN p_order <> 'asc' THEN CASE p_sort WHEN 'name' THEN lower(f.name) END END DESC NULLS LAST,
  CASE WHEN p_order = 'asc' THEN CASE p_sort WHEN 'lastActive' THEN f.last_active_at WHEN 'createdAt' THEN f.created_at END END ASC NULLS LAST,
  CASE WHEN p_order <> 'asc' THEN CASE p_sort WHEN 'lastActive' THEN f.last_active_at WHEN 'createdAt' THEN f.created_at END END DESC NULLS LAST,
  CASE WHEN p_order = 'asc' THEN CASE p_sort WHEN 'health' THEN f.health_score WHEN 'credits' THEN f.credits_remaining_micro WHEN 'errors' THEN f.error_count_7d END END ASC NULLS LAST,
  CASE WHEN p_order <> 'asc' THEN CASE p_sort WHEN 'health' THEN f.health_score WHEN 'credits' THEN f.credits_remaining_micro WHEN 'errors' THEN f.error_count_7d END END DESC NULLS LAST,
  f.created_at DESC, f.id
LIMIT LEAST(GREATEST(p_limit, 1), 20000) OFFSET GREATEST(p_offset, 0)
$$;

-- needs-attention queue: active tenants that are not healthy, worst first
CREATE FUNCTION sa_attention(p_limit integer, p_offset integer)
RETURNS TABLE (id uuid, name text, status text, plan_key text, owner_email text, last_active_at timestamptz, error_count_7d integer,
  health_score integer, health_bucket text, health_reasons jsonb, total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.id, t.name, t.status, t.plan_key,
    (SELECT u.email FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner' ORDER BY (u.status = 'active') DESC, u.created_at LIMIT 1),
    h.last_active_at, h.error_count_7d, h.score, h.bucket, h.reasons, count(*) OVER ()
  FROM tenants t JOIN sa_health_scores(NULL) h ON h.tenant_id = t.id
  WHERE t.status = 'active' AND h.bucket <> 'healthy'
  ORDER BY h.score, t.created_at DESC, t.id LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0)
$$;

-- ---- search -----------------------------------------------------------------------------------------------------
CREATE FUNCTION sa_search(p_q text, p_limit integer)
RETURNS TABLE (kind text, tenant_id uuid, tenant_name text, id uuid, label text, sublabel text, status text, plan_key text, matched_on text, role text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH q AS (SELECT replace(replace(replace(btrim(p_q), '\', '\\'), '%', '\%'), '_', '\_') AS s),
  tn AS (
    SELECT t.id, t.name, t.status, t.plan_key,
      CASE WHEN t.name ILIKE '%' || q.s || '%' THEN 'name' WHEN t.id::text ILIKE q.s || '%' THEN 'id' ELSE 'member_email' END AS m
    FROM tenants t, q
    WHERE t.name ILIKE '%' || q.s || '%' OR t.id::text ILIKE q.s || '%'
       OR EXISTS (SELECT 1 FROM users u WHERE u.tenant_id = t.id AND u.email ILIKE '%' || q.s || '%')
    ORDER BY (t.name ILIKE q.s || '%') DESC, t.created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 50))
  SELECT 'tenant'::text, tn.id, tn.name, tn.id, tn.name, NULL::text, tn.status, tn.plan_key, tn.m, NULL::text FROM tn
  UNION ALL
  (SELECT 'user'::text, u.tenant_id, t.name, u.id, u.email, u.name, u.status, t.plan_key, 'email'::text, u.role
   FROM users u JOIN tenants t ON t.id = u.tenant_id, q WHERE u.email ILIKE '%' || q.s || '%'
   ORDER BY u.created_at DESC LIMIT LEAST(GREATEST(p_limit, 1), 50))
$$;

-- ---- customer overview (header of Customer 360) ----------------------------------------------------------------------
CREATE FUNCTION sa_tenant_overview(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'tenant', jsonb_build_object('id', t.id, 'name', t.name, 'status', t.status, 'plan', t.plan_key, 'createdAt', t.created_at, 'deletedAt', t.deleted_at),
    'owner', (SELECT jsonb_build_object('email', u.email, 'name', u.name) FROM users u WHERE u.tenant_id = t.id AND u.role = 'owner'
              ORDER BY (u.status = 'active') DESC, u.created_at LIMIT 1),
    'health', jsonb_build_object('score', h.score, 'bucket', h.bucket, 'reasons', h.reasons),
    'counts', jsonb_build_object(
      'users', (SELECT count(*) FROM users WHERE tenant_id = t.id),
      'agents', (SELECT count(*) FROM agents WHERE tenant_id = t.id AND status <> 'archived'),
      'widgets', (SELECT count(*) FROM widgets WHERE tenant_id = t.id),
      'channels', (SELECT count(*) FROM channel_connections WHERE tenant_id = t.id),
      'contacts', (SELECT count(*) FROM contacts WHERE tenant_id = t.id),
      'conversations', (SELECT count(*) FROM conversations WHERE tenant_id = t.id),
      'knowledgeSources', (SELECT count(*) FROM knowledge_sources WHERE tenant_id = t.id)),
    'lastActivityAt', h.last_active_at,
    'errorCount7d', h.error_count_7d,
    'billing', (SELECT jsonb_build_object('status', b.status, 'planKey', b.plan_key, 'currentPeriodEnd', b.current_period_end,
                  'cancelAtPeriodEnd', b.cancel_at_period_end, 'graceUntil', b.grace_until) FROM billing_customers b WHERE b.tenant_id = t.id),
    'tags', COALESCE((SELECT jsonb_agg(g.tag ORDER BY g.tag) FROM tenant_tags g WHERE g.tenant_id = t.id), '[]'::jsonb),
    'notesCount', (SELECT count(*) FROM tenant_notes WHERE tenant_id = t.id))
  FROM tenants t JOIN sa_health_scores(p_id) h ON h.tenant_id = t.id WHERE t.id = p_id
$$;

-- plan limits with live usage (mirrors apps/api/src/platform/limits.ts)
CREATE FUNCTION sa_tenant_limits(p_id uuid) RETURNS TABLE (metric text, limit_value bigint, used bigint, warning boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH t AS (SELECT id, plan_key FROM tenants WHERE id = p_id),
  m AS (SELECT unnest(ARRAY['seats','agents','widgets','api_keys','monthly_conversations','storage_mb','llm_tokens_monthly','llm_credits_monthly']) AS metric),
  ctr AS (SELECT c.metric, c.value FROM usage_counters c, t WHERE c.tenant_id = t.id
            AND c.period = CASE WHEN c.metric IN ('monthly_conversations','llm_tokens_monthly','llm_credits_monthly')
                                THEN date_trunc('month', now() AT TIME ZONE 'UTC')::date ELSE DATE '1970-01-01' END),
  u AS (
    SELECT m.metric, CASE m.metric
      WHEN 'seats' THEN (SELECT count(*) FROM users WHERE tenant_id = p_id AND status = 'active')
                      + (SELECT count(*) FROM invitations WHERE tenant_id = p_id AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now())
      WHEN 'agents' THEN (SELECT count(*) FROM agents WHERE tenant_id = p_id AND status <> 'archived')
      WHEN 'api_keys' THEN (SELECT count(*) FROM api_keys WHERE tenant_id = p_id AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now()))
      WHEN 'widgets' THEN GREATEST((SELECT count(*) FROM widgets WHERE tenant_id = p_id), COALESCE((SELECT value FROM ctr WHERE ctr.metric = 'widgets'), 0))
      WHEN 'monthly_conversations' THEN GREATEST((SELECT count(*) FROM conversations WHERE tenant_id = p_id
          AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), COALESCE((SELECT value FROM ctr WHERE ctr.metric = 'monthly_conversations'), 0))
      WHEN 'storage_mb' THEN GREATEST((SELECT COALESCE(ceil(sum(size_bytes) / 1048576.0), 0)::bigint FROM knowledge_sources WHERE tenant_id = p_id),
          COALESCE((SELECT value FROM ctr WHERE ctr.metric = 'storage_mb'), 0))
      WHEN 'llm_tokens_monthly' THEN GREATEST(
          (SELECT COALESCE(sum(prompt_tokens + completion_tokens), 0) FROM ai_usage_events WHERE tenant_id = p_id AND day >= date_trunc('month', now() AT TIME ZONE 'UTC')::date),
          (SELECT COALESCE(sum(amount), 0) FROM ai_usage WHERE tenant_id = p_id AND kind IN ('llm_prompt_tokens','llm_completion_tokens') AND day >= date_trunc('month', now() AT TIME ZONE 'UTC')::date),
          COALESCE((SELECT value FROM ctr WHERE ctr.metric = 'llm_tokens_monthly'), 0))
      WHEN 'llm_credits_monthly' THEN COALESCE((SELECT ceil(used_micro / 1000000.0)::bigint FROM tenant_credits WHERE tenant_id = p_id
          AND period = date_trunc('month', now() AT TIME ZONE 'UTC')::date), 0)
      END::bigint AS used
    FROM m)
  SELECT m.metric, pl.limit_value, u.used, (pl.limit_value IS NOT NULL AND pl.limit_value > 0 AND u.used >= pl.limit_value * 0.8)
  FROM m JOIN t ON true JOIN u ON u.metric = m.metric LEFT JOIN plan_limits pl ON pl.plan_key = t.plan_key AND pl.metric = m.metric
$$;

-- ---- team ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION sa_tenant_users(p_id uuid)
RETURNS TABLE (id uuid, email text, name text, role text, status text, last_login_at timestamptz, created_at timestamptz, locked boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, email, name, role, status, last_login_at, created_at, COALESCE(locked_until > now(), false)
  FROM users WHERE tenant_id = p_id ORDER BY (role = 'owner') DESC, created_at, id
$$;
CREATE FUNCTION sa_tenant_invitations(p_id uuid)
RETURNS TABLE (id uuid, email text, role text, created_at timestamptz, expires_at timestamptz, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, email, role, created_at, expires_at,
    CASE WHEN accepted_at IS NOT NULL THEN 'accepted' WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN expires_at <= now() THEN 'expired' ELSE 'pending' END
  FROM invitations WHERE tenant_id = p_id ORDER BY created_at DESC, id LIMIT 200
$$;

-- ---- timeline (no message text, no tenant audit metadata) -----------------------------------------------------------------
CREATE FUNCTION sa_tenant_timeline(p_tenant uuid, p_source text, p_limit integer, p_offset integer)
RETURNS TABLE (at timestamptz, source text, action text, actor text, resource_type text, resource_id text, detail jsonb, total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH e AS (
    SELECT a.created_at AS at, 'tenant_audit'::text AS source, a.action, COALESCE(u.name, 'system') AS actor, a.resource_type,
           CASE WHEN a.resource_type = 'http' THEN NULL ELSE a.resource_id END AS resource_id, NULL::jsonb AS detail
    FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id AND u.tenant_id = a.tenant_id WHERE a.tenant_id = p_tenant
    UNION ALL
    SELECT l.created_at, CASE WHEN l.action LIKE 'impersonation.%' THEN 'impersonation' ELSE 'platform_audit' END, l.action,
           COALESCE(pa.email, 'platform'), NULL, NULL, l.metadata
    FROM platform_audit_logs l LEFT JOIN platform_admins pa ON pa.id = l.admin_id WHERE l.tenant_id = p_tenant AND l.action NOT IN ('tenant.view')
    UNION ALL
    SELECT b.received_at, 'billing', b.type, 'billing provider', NULL, NULL, NULL FROM billing_events b WHERE b.tenant_id = p_tenant
    UNION ALL
    SELECT h.created_at, 'handoff', 'handoff.' || h.type, 'system', 'handoff', h.id::text, NULL FROM handoffs h WHERE h.tenant_id = p_tenant)
  SELECT e.at, e.source, e.action, e.actor, e.resource_type, e.resource_id, e.detail, count(*) OVER ()
  FROM e WHERE p_source IS NULL OR e.source = p_source
  ORDER BY e.at DESC LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0)
$$;

-- ---- failures (kind, when, reference, short title, stored error string) ------------------------------------------------------
CREATE FUNCTION sa_tenant_error_rows(p_tenant uuid, p_days integer)
RETURNS TABLE (kind text, at timestamptz, ref_id text, title text, detail text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH c AS (SELECT now() - make_interval(days => LEAST(GREATEST(p_days, 1), 90)) AS since)
  SELECT 'job_failed'::text, j.updated_at, j.id::text, j.name, left(COALESCE(j.last_error, ''), 500)
    FROM jobs j, c WHERE j.tenant_id = p_tenant AND j.status = 'dead' AND j.updated_at > c.since
  UNION ALL
  SELECT 'webhook_delivery_failed', COALESCE(d.completed_at, d.created_at), d.id::text, w.name || ' - ' || d.event_type,
         left(COALESCE(d.last_error, CASE WHEN d.response_status IS NOT NULL THEN 'HTTP ' || d.response_status ELSE '' END), 500)
    FROM webhook_deliveries d JOIN webhooks w ON w.id = d.webhook_id AND w.tenant_id = d.tenant_id, c
    WHERE d.tenant_id = p_tenant AND d.status = 'failed' AND COALESCE(d.completed_at, d.created_at) > c.since
  UNION ALL
  SELECT 'channel_error', COALESCE(k.last_health_at, k.updated_at), k.id::text, k.channel || ' ' || k.name, left(COALESCE(k.last_health_error, 'Connection reported an error'), 500)
    FROM channel_connections k WHERE k.tenant_id = p_tenant AND (k.status = 'error' OR k.last_health_ok = false)
  UNION ALL
  SELECT 'channel_delivery_failed', d.created_at, d.id::text, d.channel, left(COALESCE(d.error, ''), 500)
    FROM channel_deliveries d, c WHERE d.tenant_id = p_tenant AND d.status = 'failed' AND d.created_at > c.since
  UNION ALL
  SELECT 'knowledge_ingest_failed', s.updated_at, s.id::text, s.name, left(COALESCE(s.error, ''), 500)
    FROM knowledge_sources s, c WHERE s.tenant_id = p_tenant AND s.status = 'failed' AND s.updated_at > c.since
  UNION ALL
  SELECT 'notification_email_failed', n.created_at, n.id::text, n.type, left(COALESCE(n.email_error, ''), 500)
    FROM notifications n, c WHERE n.tenant_id = p_tenant AND n.email_status = 'failed' AND n.created_at > c.since
  UNION ALL
  SELECT 'crm_sync_failed', l.created_at, l.id::text, l.provider || ' ' || COALESCE(l.action, l.trigger), left(COALESCE(l.error, ''), 500)
    FROM crm_sync_log l, c WHERE l.tenant_id = p_tenant AND l.status = 'failed' AND l.created_at > c.since
  UNION ALL
  SELECT 'handoff_system_failure', h.created_at, h.id::text, 'System failure', left(COALESCE(h.reason, ''), 200)
    FROM handoffs h, c WHERE h.tenant_id = p_tenant AND h.type = 'system_failure' AND h.created_at > c.since
  UNION ALL
  SELECT 'abuse_handoff', h.created_at, h.id::text, 'Abuse flagged', ''
    FROM handoffs h, c WHERE h.tenant_id = p_tenant AND h.type = 'abuse' AND h.created_at > c.since
  UNION ALL
  SELECT 'tool_failed', x.created_at, x.id::text, x.tool_name, left(COALESCE(x.error, ''), 300)
    FROM tool_executions x, c WHERE x.tenant_id = p_tenant AND x.success = false AND x.created_at > c.since
$$;
CREATE FUNCTION sa_tenant_errors(p_tenant uuid, p_kind text, p_days integer, p_limit integer, p_offset integer)
RETURNS TABLE (kind text, at timestamptz, ref_id text, title text, detail text, total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.kind, e.at, e.ref_id, e.title, e.detail, count(*) OVER ()
  FROM sa_tenant_error_rows(p_tenant, p_days) e WHERE p_kind IS NULL OR e.kind = p_kind
  ORDER BY e.at DESC, e.ref_id LIMIT LEAST(GREATEST(p_limit, 1), 20000) OFFSET GREATEST(p_offset, 0)
$$;
CREATE FUNCTION sa_tenant_error_counts(p_tenant uuid, p_days integer) RETURNS TABLE (kind text, n bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT kind, count(*) FROM sa_tenant_error_rows(p_tenant, p_days) GROUP BY kind
$$;

-- ---- assets: what the customer has set up, with status (no secrets, hosts instead of URLs) ------------------------------------
CREATE FUNCTION sa_tenant_assets(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'agents', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'status', a.status, 'publishedVersion', a.published_version, 'updatedAt', a.updated_at) ORDER BY a.created_at)
                        FROM agents a WHERE a.tenant_id = p_id), '[]'::jsonb),
    'widgets', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', w.id, 'name', w.name, 'enabled', w.enabled, 'agentId', w.agent_id, 'domains', COALESCE(cardinality(w.allowed_domains), 0)) ORDER BY w.created_at)
                         FROM widgets w WHERE w.tenant_id = p_id), '[]'::jsonb),
    'channels', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'channel', c.channel, 'name', c.name, 'status', c.status, 'agentId', c.agent_id,
                            'lastHealthAt', c.last_health_at, 'lastHealthOk', c.last_health_ok, 'lastHealthError', left(c.last_health_error, 300)) ORDER BY c.created_at)
                          FROM channel_connections c WHERE c.tenant_id = p_id), '[]'::jsonb),
    'knowledge', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'type', k.type, 'status', k.status, 'error', left(k.error, 300),
                            'chunkCount', k.chunk_count, 'lastIngestedAt', k.last_ingested_at) ORDER BY k.created_at)
                           FROM knowledge_sources k WHERE k.tenant_id = p_id), '[]'::jsonb),
    'connections', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'kind', t.kind, 'authType', t.auth_type,
                            'host', substring(t.base_url from '^[a-z]+://([^/:?#]+)')) ORDER BY t.created_at)
                             FROM tool_connections t WHERE t.tenant_id = p_id), '[]'::jsonb),
    'webhooks', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', h.id, 'name', h.name, 'enabled', h.enabled, 'host', substring(h.url from '^[a-z]+://([^/:?#]+)'),
                            'disabledReason', left(h.disabled_reason, 200), 'consecutiveFailures', h.consecutive_failures,
                            'lastSuccessAt', h.last_success_at, 'lastFailureAt', h.last_failure_at) ORDER BY h.created_at)
                          FROM webhooks h WHERE h.tenant_id = p_id), '[]'::jsonb),
    'calendar', COALESCE((SELECT jsonb_agg(jsonb_build_object('provider', c.provider, 'status', c.status, 'lastError', left(c.last_error, 300)))
                          FROM calendar_connections c WHERE c.tenant_id = p_id), '[]'::jsonb),
    'crm', COALESCE((SELECT jsonb_agg(jsonb_build_object('provider', c.provider, 'status', c.status, 'lastError', left(c.last_error, 300), 'lastSyncAt', c.last_sync_at))
                     FROM crm_connections c WHERE c.tenant_id = p_id), '[]'::jsonb))
  WHERE EXISTS (SELECT 1 FROM tenants WHERE id = p_id)
$$;

-- ---- billing + AI usage ---------------------------------------------------------------------------------------------------
CREATE FUNCTION sa_tenant_billing(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'plan', t.plan_key,
    'subscription', (SELECT jsonb_build_object('status', b.status, 'planKey', b.plan_key, 'currentPeriodEnd', b.current_period_end,
                       'cancelAtPeriodEnd', b.cancel_at_period_end, 'graceUntil', b.grace_until) FROM billing_customers b WHERE b.tenant_id = t.id),
    'events', COALESCE((SELECT jsonb_agg(jsonb_build_object('type', e.type, 'receivedAt', e.received_at) ORDER BY e.received_at DESC)
                        FROM (SELECT type, received_at FROM billing_events WHERE tenant_id = t.id ORDER BY received_at DESC LIMIT 50) e), '[]'::jsonb),
    'topups', COALESCE((SELECT jsonb_agg(jsonb_build_object('at', x.created_at, 'credits', x.credits_micro / 1000000.0, 'amountCents', x.amount_cents, 'pack', x.pack) ORDER BY x.created_at DESC)
                        FROM (SELECT u.created_at, u.credits_micro, u.amount_cents, p.name AS pack FROM credit_topups u LEFT JOIN credit_packs p ON p.id = u.pack_id
                              WHERE u.tenant_id = t.id ORDER BY u.created_at DESC LIMIT 20) x), '[]'::jsonb))
  FROM tenants t WHERE t.id = p_id
$$;
CREATE FUNCTION sa_tenant_ai_usage(p_id uuid, p_days integer)
RETURNS TABLE (day date, model text, source text, requests bigint, prompt_tokens bigint, completion_tokens bigint, credits_micro bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.day, COALESCE(e.model, 'unknown'), e.source, count(*), COALESCE(sum(e.prompt_tokens), 0)::bigint, COALESCE(sum(e.completion_tokens), 0)::bigint, COALESCE(sum(e.credits_micro), 0)::bigint
  FROM ai_usage_events e WHERE e.tenant_id = p_id AND e.day >= (now() AT TIME ZONE 'UTC')::date - LEAST(GREATEST(p_days, 1), 365)
  GROUP BY e.day, e.model, e.source ORDER BY e.day, e.model, e.source
$$;

-- ---- notes and tags ---------------------------------------------------------------------------------------------------------------
CREATE FUNCTION sa_tenant_notes(p_id uuid) RETURNS TABLE (id uuid, body text, admin_id uuid, admin_email text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, body, admin_id, admin_email, created_at FROM tenant_notes WHERE tenant_id = p_id ORDER BY created_at DESC, id LIMIT 200
$$;
CREATE FUNCTION sa_tenant_tags(p_id uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE(array_agg(tag ORDER BY tag), '{}') FROM tenant_tags WHERE tenant_id = p_id
$$;
CREATE FUNCTION sa_list_tags() RETURNS TABLE (tag text, n bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT tag, count(*) FROM tenant_tags GROUP BY tag ORDER BY tag
$$;

-- ---- platform overview (KPIs with previous-period deltas and 30-day series) -------------------------------------------------------
CREATE FUNCTION sa_overview() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'tenants', jsonb_build_object(
      'total', (SELECT count(*) FROM tenants),
      'active', (SELECT count(*) FROM tenants WHERE status = 'active'),
      'suspended', (SELECT count(*) FROM tenants WHERE status = 'suspended'),
      'deleted', (SELECT count(*) FROM tenants WHERE status = 'deleted'),
      'new7d', (SELECT count(*) FROM tenants WHERE created_at >= now() - interval '7 days'),
      'new30d', (SELECT count(*) FROM tenants WHERE created_at >= now() - interval '30 days'),
      'newPrev30d', (SELECT count(*) FROM tenants WHERE created_at >= now() - interval '60 days' AND created_at < now() - interval '30 days')),
    'active7d', (SELECT count(DISTINCT tenant_id) FROM messages WHERE created_at >= now() - interval '7 days'),
    'activePrev7d', (SELECT count(DISTINCT tenant_id) FROM messages WHERE created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days'),
    'mrrCents', COALESCE((SELECT sum(p.monthly_cents) FROM tenants t JOIN plan_prices p ON p.plan_key = t.plan_key WHERE t.status = 'active'), 0),
    'creditsConsumed30d', COALESCE((SELECT sum(credits_micro) FROM ai_usage_events WHERE at >= now() - interval '30 days'), 0),
    'creditsConsumedPrev30d', COALESCE((SELECT sum(credits_micro) FROM ai_usage_events WHERE at >= now() - interval '60 days' AND at < now() - interval '30 days'), 0),
    'healthBuckets', (SELECT jsonb_build_object(
        'healthy', count(*) FILTER (WHERE h.bucket = 'healthy'), 'watch', count(*) FILTER (WHERE h.bucket = 'watch'), 'at_risk', count(*) FILTER (WHERE h.bucket = 'at_risk'))
      FROM sa_health_scores(NULL) h JOIN tenants t ON t.id = h.tenant_id WHERE t.status = 'active'),
    'byPlan', COALESCE((SELECT jsonb_agg(jsonb_build_object('plan', plan_key, 'count', n) ORDER BY plan_key)
                        FROM (SELECT plan_key, count(*) AS n FROM tenants WHERE status <> 'deleted' GROUP BY plan_key) x), '[]'::jsonb),
    'series', jsonb_build_object(
      'signups', COALESCE((SELECT jsonb_agg(jsonb_build_object('day', d, 'value', n) ORDER BY d)
                           FROM (SELECT (created_at AT TIME ZONE 'UTC')::date AS d, count(*) AS n FROM tenants WHERE created_at >= now() - interval '30 days' GROUP BY 1) s), '[]'::jsonb),
      'conversations', COALESCE((SELECT jsonb_agg(jsonb_build_object('day', d, 'value', n) ORDER BY d)
                           FROM (SELECT (created_at AT TIME ZONE 'UTC')::date AS d, count(*) AS n FROM conversations WHERE created_at >= now() - interval '30 days' GROUP BY 1) s), '[]'::jsonb),
      'credits', COALESCE((SELECT jsonb_agg(jsonb_build_object('day', d, 'value', n) ORDER BY d)
                           FROM (SELECT day AS d, sum(credits_micro)::bigint AS n FROM ai_usage_events WHERE at >= now() - interval '30 days' GROUP BY 1) s), '[]'::jsonb)))
$$;

-- ---- operations ------------------------------------------------------------------------------------------------------------------------
CREATE FUNCTION sa_dead_jobs(p_tenant uuid, p_limit integer, p_offset integer)
RETURNS TABLE (id uuid, tenant_id uuid, tenant_name text, name text, attempts integer, max_attempts integer, last_error text, created_at timestamptz, updated_at timestamptz, total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT j.id, j.tenant_id, t.name, j.name, j.attempts, j.max_attempts, left(COALESCE(j.last_error, ''), 500), j.created_at, j.updated_at, count(*) OVER ()
  FROM jobs j JOIN tenants t ON t.id = j.tenant_id WHERE j.status = 'dead' AND (p_tenant IS NULL OR j.tenant_id = p_tenant)
  ORDER BY j.updated_at DESC, j.id LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0)
$$;
CREATE FUNCTION sa_failed_webhooks(p_tenant uuid, p_limit integer, p_offset integer)
RETURNS TABLE (id uuid, tenant_id uuid, tenant_name text, webhook_id uuid, webhook_name text, event_type text, status text, attempts integer,
  response_status integer, last_error text, created_at timestamptz, completed_at timestamptz, total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, d.tenant_id, t.name, d.webhook_id, w.name, d.event_type, d.status, d.attempts, d.response_status, left(COALESCE(d.last_error, ''), 500),
         d.created_at, d.completed_at, count(*) OVER ()
  FROM webhook_deliveries d JOIN tenants t ON t.id = d.tenant_id JOIN webhooks w ON w.id = d.webhook_id AND w.tenant_id = d.tenant_id
  WHERE d.status = 'failed' AND (p_tenant IS NULL OR d.tenant_id = p_tenant)
  ORDER BY COALESCE(d.completed_at, d.created_at) DESC, d.id LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0)
$$;

-- ---- catalogue reads (the admin role has no table grants) ---------------------------------------------------------------------------------
CREATE FUNCTION sa_list_plans() RETURNS TABLE (key text, name text, metric text, limit_value bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.key, p.name, l.metric, l.limit_value FROM plans p LEFT JOIN plan_limits l ON l.plan_key = p.key ORDER BY p.key, l.metric
$$;
CREATE FUNCTION sa_list_flags() RETURNS TABLE (key text, description text, default_enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT key, description, default_enabled FROM feature_flags ORDER BY key
$$;
CREATE FUNCTION sa_list_model_rates() RETURNS TABLE (model text, input_micro_per_1k bigint, output_micro_per_1k bigint, enabled boolean, updated_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT model, input_micro_per_1k, output_micro_per_1k, enabled, updated_at FROM llm_model_rates ORDER BY (model = '*') DESC, model
$$;
CREATE FUNCTION sa_list_credit_packs() RETURNS TABLE (id uuid, name text, credits bigint, price_cents integer, currency text, active boolean, sort_order integer, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, name, credits, price_cents, currency, active, sort_order, created_at FROM credit_packs ORDER BY sort_order, price_cents, id
$$;
CREATE FUNCTION sa_llm_profile_for_test(p_id uuid)
RETURNS TABLE (id uuid, name text, base_url text, auth_header text, auth_scheme text, extra_headers jsonb, query_params jsonb, chat_path text,
  credentials_encrypted text, default_model text, enabled_models text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, name, base_url, auth_header, auth_scheme, extra_headers, query_params, chat_path, credentials_encrypted, default_model, enabled_models
  FROM llm_provider_profiles WHERE id = p_id
$$;
