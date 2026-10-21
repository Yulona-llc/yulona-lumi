-- Integrations (migration range 0500-0599): outbound webhooks (+ delivery log), GDPR requests,
-- retention policies, and the SECURITY DEFINER helpers behind them. Run as the owner role.

-- ---- Outbound webhooks ----------------------------------------------------------------------------
CREATE TABLE webhooks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  name                 text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  url                  text NOT NULL CHECK (char_length(url) <= 2000),
  -- signing secret, AES-256-GCM sealed with ENCRYPTION_KEY (never returned after creation)
  secret_encrypted     text NOT NULL,
  events               text[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 20),
  enabled              boolean NOT NULL DEFAULT true,
  disabled_reason      text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_success_at      timestamptz,
  last_failure_at      timestamptz,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX webhooks_tenant_idx ON webhooks (tenant_id, created_at);

CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  webhook_id      uuid NOT NULL,
  event_id        uuid NOT NULL,
  event_type      text NOT NULL,
  payload         jsonb NOT NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','retrying','succeeded','failed','cancelled')),
  attempts        integer NOT NULL DEFAULT 0,
  max_attempts    integer NOT NULL DEFAULT 8,
  next_attempt_at timestamptz,
  response_status integer,
  last_error      text,
  last_duration_ms integer,
  redelivery_of   uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, webhook_id) REFERENCES webhooks (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX webhook_deliveries_hook_idx ON webhook_deliveries (tenant_id, webhook_id, created_at DESC, id DESC);
CREATE INDEX webhook_deliveries_created_idx ON webhook_deliveries (created_at);

CREATE TABLE webhook_delivery_attempts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  delivery_id      uuid NOT NULL,
  attempt          integer NOT NULL,
  status_code      integer,
  error            text,
  duration_ms      integer,
  response_snippet text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES webhook_deliveries (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX webhook_delivery_attempts_idx ON webhook_delivery_attempts (tenant_id, delivery_id, attempt);

-- ---- GDPR requests ---------------------------------------------------------------------------------
CREATE TABLE gdpr_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  kind               text NOT NULL CHECK (kind IN ('export','erasure')),
  -- NULL for a whole-workspace export
  subject_contact_id uuid,
  status             text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','completed','failed')),
  requested_by       uuid,
  storage_key        text,
  size_bytes         bigint,
  result             jsonb NOT NULL DEFAULT '{}'::jsonb,
  error              text,
  expires_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  completed_at       timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, requested_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX gdpr_requests_tenant_idx ON gdpr_requests (tenant_id, created_at DESC, id DESC);
CREATE INDEX gdpr_requests_expiry_idx ON gdpr_requests (expires_at) WHERE storage_key IS NOT NULL;

-- ---- Retention policy (one row per tenant; NULL = keep) -------------------------------------------
CREATE TABLE retention_policies (
  tenant_id         uuid PRIMARY KEY REFERENCES tenants(id),
  messages_days     integer CHECK (messages_days IS NULL OR messages_days BETWEEN 7 AND 3650),
  audit_logs_days   integer CHECK (audit_logs_days IS NULL OR audit_logs_days BETWEEN 30 AND 3650),
  webhook_logs_days integer CHECK (webhook_logs_days IS NULL OR webhook_logs_days BETWEEN 1 AND 365),
  tool_logs_days    integer CHECK (tool_logs_days IS NULL OR tool_logs_days BETWEEN 7 AND 3650),
  updated_by        uuid,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---- RLS ------------------------------------------------------------------------------------------
DO $$
DECLARE t text; owner_role text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['webhooks','webhook_deliveries','webhook_delivery_attempts','gdpr_requests','retention_policies'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, owner_role);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO yulona_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON webhooks TO yulona_app;
GRANT SELECT, INSERT, UPDATE ON webhook_deliveries TO yulona_app;
GRANT SELECT, INSERT ON webhook_delivery_attempts TO yulona_app;
GRANT SELECT, INSERT, UPDATE ON gdpr_requests TO yulona_app;
GRANT SELECT, INSERT, UPDATE ON retention_policies TO yulona_app;

-- ---- Event fan-out ---------------------------------------------------------------------------------
-- Writers (API, AI worker, channels, ops) never call webhooks directly: AFTER triggers on the source
-- tables call webhook_emit() inside the writer's own transaction, so an event exists iff its row commits.
-- webhook_emit is SECURITY DEFINER so it works for any caller role; it refuses cross-tenant calls from
-- a tenant-scoped session and honours `yulona.webhooks_off` (set by GDPR erasure to stay silent).
CREATE FUNCTION webhook_emit(p_tenant uuid, p_type text, p_data jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE w record; ev uuid := gen_random_uuid(); d uuid; n integer := 0; payload jsonb;
BEGIN
  IF app_tenant_id() IS NOT NULL AND app_tenant_id() <> p_tenant THEN RETURN 0; END IF;
  IF current_setting('yulona.webhooks_off', true) = '1' THEN RETURN 0; END IF;
  FOR w IN SELECT id FROM webhooks
           WHERE tenant_id = p_tenant AND enabled AND (p_type = ANY(events) OR '*' = ANY(events)) LOOP
    IF payload IS NULL THEN
      payload := jsonb_build_object('id', ev, 'type', p_type,
        'createdAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'tenantId', p_tenant, 'data', p_data);
    END IF;
    INSERT INTO webhook_deliveries (tenant_id, webhook_id, event_id, event_type, payload, next_attempt_at)
    VALUES (p_tenant, w.id, ev, p_type, payload, now()) RETURNING id INTO d;
    INSERT INTO jobs (tenant_id, name, payload, max_attempts)
    VALUES (p_tenant, 'webhook.deliver', jsonb_build_object('deliveryId', d), 3);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

CREATE FUNCTION webhooks_on_conversation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM webhook_emit(NEW.tenant_id, 'conversation.created', jsonb_build_object('conversation', jsonb_build_object(
    'id', NEW.id, 'contactId', NEW.contact_id, 'channel', NEW.channel, 'status', NEW.status, 'handler', NEW.handler,
    'widgetId', NEW.widget_id, 'agentId', NEW.agent_id, 'createdAt', NEW.created_at)));
  RETURN NULL;
END $$;
CREATE TRIGGER webhooks_conversation_insert AFTER INSERT ON conversations FOR EACH ROW EXECUTE FUNCTION webhooks_on_conversation();

CREATE FUNCTION webhooks_on_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- internal notes and system lines are never sent out
  IF NEW.sender_type IN ('contact','ai','human') THEN
    PERFORM webhook_emit(NEW.tenant_id, 'message.created', jsonb_build_object('message', jsonb_build_object(
      'id', NEW.id, 'conversationId', NEW.conversation_id, 'senderType', NEW.sender_type,
      'content', NEW.content, 'createdAt', NEW.created_at)));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER webhooks_message_insert AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION webhooks_on_message();

CREATE FUNCTION webhooks_on_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM webhook_emit(NEW.tenant_id, 'handoff.requested', jsonb_build_object('handoff', jsonb_build_object(
    'id', NEW.id, 'conversationId', NEW.conversation_id, 'type', NEW.type, 'reason', NEW.reason,
    'summary', NEW.summary, 'leadCard', NEW.lead_card, 'createdAt', NEW.created_at)));
  RETURN NULL;
END $$;
CREATE TRIGGER webhooks_handoff_insert AFTER INSERT ON handoffs FOR EACH ROW EXECUTE FUNCTION webhooks_on_handoff();

CREATE FUNCTION webhooks_contact_json(c contacts) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object('id', c.id, 'name', c.name, 'email', c.email, 'phone', c.phone,
    'customAttributes', c.custom_attributes, 'createdAt', c.created_at, 'updatedAt', c.updated_at)
$$;

CREATE FUNCTION webhooks_on_contact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM webhook_emit(NEW.tenant_id, 'contact.created', jsonb_build_object('contact', webhooks_contact_json(NEW)));
  ELSIF (NEW.name, NEW.email, NEW.phone, NEW.custom_attributes, NEW.merged_into)
        IS DISTINCT FROM (OLD.name, OLD.email, OLD.phone, OLD.custom_attributes, OLD.merged_into) THEN
    PERFORM webhook_emit(NEW.tenant_id, 'contact.updated', jsonb_build_object('contact', webhooks_contact_json(NEW)));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER webhooks_contact_insert AFTER INSERT ON contacts FOR EACH ROW EXECUTE FUNCTION webhooks_on_contact();
CREATE TRIGGER webhooks_contact_update AFTER UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION webhooks_on_contact();

-- Schema-agnostic row events for tables owned by other agents (tickets, bookings): the row is sent as
-- camelCased JSON (sensitive-looking columns dropped). Attached only when the table exists; re-run
-- webhooks_attach_optional_triggers() (idempotent) after creating those tables.
CREATE FUNCTION webhooks_camel(j jsonb) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE k text; v text; out jsonb := '{}'::jsonb;
BEGIN
  FOR k IN SELECT jsonb_object_keys(j) LOOP
    CONTINUE WHEN k ~* '(token|secret|credential|password|hash)';
    v := replace(initcap(replace(k, '_', ' ')), ' ', '');
    out := out || jsonb_build_object(lower(left(v, 1)) || substr(v, 2), j -> k);
  END LOOP;
  RETURN out;
END $$;

CREATE FUNCTION webhooks_on_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j jsonb := to_jsonb(NEW);
BEGIN
  IF TG_OP = 'UPDATE' AND (j - 'updated_at') = (to_jsonb(OLD) - 'updated_at') THEN RETURN NULL; END IF;
  PERFORM webhook_emit((j ->> 'tenant_id')::uuid, TG_ARGV[0], jsonb_build_object(TG_ARGV[1], webhooks_camel(j)));
  RETURN NULL;
END $$;

CREATE FUNCTION webhooks_attach_optional_triggers() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF to_regclass('public.tickets') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'webhooks_ticket_insert' AND tgrelid = 'public.tickets'::regclass) THEN
      CREATE TRIGGER webhooks_ticket_insert AFTER INSERT ON tickets FOR EACH ROW EXECUTE FUNCTION webhooks_on_row('ticket.created', 'ticket');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'webhooks_ticket_update' AND tgrelid = 'public.tickets'::regclass) THEN
      CREATE TRIGGER webhooks_ticket_update AFTER UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION webhooks_on_row('ticket.updated', 'ticket');
    END IF;
  END IF;
  IF to_regclass('public.bookings') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'webhooks_booking_insert' AND tgrelid = 'public.bookings'::regclass) THEN
      CREATE TRIGGER webhooks_booking_insert AFTER INSERT ON bookings FOR EACH ROW EXECUTE FUNCTION webhooks_on_row('booking.created', 'booking');
    END IF;
  END IF;
END $$;
SELECT webhooks_attach_optional_triggers();

-- ---- GDPR erasure ----------------------------------------------------------------------------------
-- The app role has no UPDATE/DELETE on messages etc., so erasure runs as a definer function that is
-- hard-bound to the caller's tenant (p_tenant must equal the session's app.current_tenant_id).
-- Rows are anonymised in place (ids/timestamps stay so conversations, funnel metrics and FKs remain valid).
CREATE FUNCTION gdpr_erase_contact(p_tenant uuid, p_contact uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ids uuid[]; convs uuid[]; n_msg integer; n_id integer; retained jsonb := '[]'::jsonb; t text; cnt bigint;
BEGIN
  IF p_tenant IS NULL OR app_tenant_id() IS DISTINCT FROM p_tenant THEN RAISE EXCEPTION 'tenant mismatch'; END IF;
  PERFORM set_config('yulona.webhooks_off', '1', true);
  WITH RECURSIVE m AS (
    SELECT id FROM contacts WHERE tenant_id = p_tenant AND id = p_contact
    UNION SELECT c.id FROM contacts c JOIN m ON c.merged_into = m.id WHERE c.tenant_id = p_tenant
  ) SELECT array_agg(id) INTO ids FROM m;
  IF ids IS NULL THEN RAISE EXCEPTION 'contact not found'; END IF;
  SELECT coalesce(array_agg(id), '{}') INTO convs FROM conversations WHERE tenant_id = p_tenant AND contact_id = ANY(ids);

  UPDATE messages SET content = '[erased]', ui = NULL, metadata = '{}'::jsonb, client_message_id = NULL
    WHERE tenant_id = p_tenant AND conversation_id = ANY(convs) AND content <> '[erased]';
  GET DIAGNOSTICS n_msg = ROW_COUNT;
  UPDATE conversations SET last_message_preview = NULL, metadata = '{}'::jsonb, updated_at = now()
    WHERE tenant_id = p_tenant AND id = ANY(convs);
  UPDATE widget_sessions SET ip = NULL, user_agent = NULL, origin = NULL, revoked_at = coalesce(revoked_at, now())
    WHERE tenant_id = p_tenant AND contact_id = ANY(ids);
  UPDATE conversation_ai_state SET lead = '{}'::jsonb, updated_at = now()
    WHERE tenant_id = p_tenant AND conversation_id = ANY(convs);
  UPDATE handoffs SET summary = NULL, lead_card = NULL, context = '{}'::jsonb
    WHERE tenant_id = p_tenant AND conversation_id = ANY(convs);
  UPDATE tool_executions SET input = '{}'::jsonb, output = NULL, error = NULL
    WHERE tenant_id = p_tenant AND conversation_id = ANY(convs);
  DELETE FROM contact_identities WHERE tenant_id = p_tenant AND contact_id = ANY(ids);
  GET DIAGNOSTICS n_id = ROW_COUNT;
  UPDATE contacts SET name = NULL, email = NULL, phone = NULL, custom_attributes = '{"erased": true}'::jsonb, updated_at = now()
    WHERE tenant_id = p_tenant AND id = ANY(ids);

  -- Tables owned by other waves that reference the contact are reported, not silently rewritten
  -- (tickets/bookings/transactions may be subject to legal retention).
  FOREACH t IN ARRAY ARRAY['tickets','bookings','transactions'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL AND EXISTS (
         SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t AND column_name = 'contact_id') THEN
      EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id = $1 AND contact_id = ANY($2)', t) INTO cnt USING p_tenant, ids;
      IF cnt > 0 THEN retained := retained || jsonb_build_object('table', t, 'rows', cnt); END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('contacts', cardinality(ids), 'messagesRedacted', n_msg, 'identitiesDeleted', n_id,
                            'conversations', cardinality(convs), 'retained', retained);
END $$;

-- ---- Retention sweep -------------------------------------------------------------------------------
-- Deletes in bounded batches (call repeatedly; returns how much it removed). Messages are purged only
-- from conversations that have been idle past the cutoff, so live conversations keep their context.
CREATE FUNCTION retention_run_all(p_batch integer DEFAULT 5000) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p record; cutoff timestamptz; n integer; msgs bigint := 0; audits bigint := 0; hooks bigint := 0; tools bigint := 0;
BEGIN
  p_batch := LEAST(GREATEST(p_batch, 1), 50000);
  FOR p IN SELECT * FROM retention_policies LOOP
    IF p.messages_days IS NOT NULL THEN
      cutoff := now() - make_interval(days => p.messages_days);
      DELETE FROM messages WHERE id IN (
        SELECT m.id FROM messages m JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
        WHERE m.tenant_id = p.tenant_id AND m.created_at < cutoff AND c.last_message_at < cutoff LIMIT p_batch);
      GET DIAGNOSTICS n = ROW_COUNT; msgs := msgs + n;
      IF n > 0 THEN
        UPDATE conversations SET last_message_preview = NULL
          WHERE tenant_id = p.tenant_id AND last_message_at < cutoff AND last_message_preview IS NOT NULL;
      END IF;
    END IF;
    IF p.audit_logs_days IS NOT NULL THEN
      DELETE FROM audit_logs WHERE id IN (SELECT id FROM audit_logs WHERE tenant_id = p.tenant_id
        AND created_at < now() - make_interval(days => p.audit_logs_days) LIMIT p_batch);
      GET DIAGNOSTICS n = ROW_COUNT; audits := audits + n;
    END IF;
    IF p.tool_logs_days IS NOT NULL THEN
      DELETE FROM tool_executions WHERE id IN (SELECT id FROM tool_executions WHERE tenant_id = p.tenant_id
        AND created_at < now() - make_interval(days => p.tool_logs_days) LIMIT p_batch);
      GET DIAGNOSTICS n = ROW_COUNT; tools := tools + n;
    END IF;
  END LOOP;
  -- Webhook delivery logs: every tenant, default 30 days unless its policy says otherwise.
  DELETE FROM webhook_deliveries WHERE id IN (
    SELECT d.id FROM webhook_deliveries d LEFT JOIN retention_policies r ON r.tenant_id = d.tenant_id
    WHERE d.status <> 'pending' AND d.status <> 'retrying'
      AND d.created_at < now() - make_interval(days => coalesce(r.webhook_logs_days, 30)) LIMIT p_batch);
  GET DIAGNOSTICS n = ROW_COUNT; hooks := hooks + n;
  RETURN jsonb_build_object('messages', msgs, 'auditLogs', audits, 'toolExecutions', tools, 'webhookDeliveries', hooks);
END $$;

-- Expired GDPR export files: claim returns what to delete from object storage; mark clears the key.
CREATE FUNCTION gdpr_expired_exports(p_limit integer DEFAULT 100)
RETURNS TABLE (id uuid, tenant_id uuid, storage_key text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT g.id, g.tenant_id, g.storage_key FROM gdpr_requests g
  WHERE g.storage_key IS NOT NULL AND g.expires_at < now() ORDER BY g.expires_at LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
CREATE FUNCTION gdpr_expired_mark(p_id uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE gdpr_requests SET storage_key = NULL WHERE id = p_id AND expires_at < now()
$$;

REVOKE ALL ON FUNCTION webhook_emit(uuid,text,jsonb), webhooks_on_conversation(), webhooks_on_message(), webhooks_on_handoff(),
  webhooks_on_contact(), webhooks_on_row(), webhooks_attach_optional_triggers(), gdpr_erase_contact(uuid,uuid),
  retention_run_all(integer), gdpr_expired_exports(integer), gdpr_expired_mark(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION webhook_emit(uuid,text,jsonb), webhooks_on_conversation(), webhooks_on_message(), webhooks_on_handoff(),
  webhooks_on_contact(), webhooks_on_row(), gdpr_erase_contact(uuid,uuid), retention_run_all(integer),
  gdpr_expired_exports(integer), gdpr_expired_mark(uuid) TO yulona_app;
