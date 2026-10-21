-- Ops domain (migration range 0400-0499): tickets, transactions, bookings + calendar, Needs Attention routing,
-- availability, business hours, canned responses, tags, notifications. Run as the owner role.
-- Existing tables from other ranges (handoffs, conversations, messages, users) are only extended/read here.

-- ---- settings: SLA, business hours, out-of-hours behaviour, routing -----------------------------
CREATE TABLE ops_settings (
  tenant_id            uuid PRIMARY KEY REFERENCES tenants(id),
  timezone             text NOT NULL DEFAULT 'UTC' CHECK (char_length(timezone) BETWEEN 1 AND 64),
  sla_minutes          jsonb NOT NULL DEFAULT '{"urgent":60,"high":240,"normal":1440,"low":4320}'::jsonb,
  out_of_hours_mode    text NOT NULL DEFAULT 'ai_only' CHECK (out_of_hours_mode IN ('ai_only','message','queue')),
  out_of_hours_message text CHECK (out_of_hours_message IS NULL OR char_length(out_of_hours_message) <= 1000),
  assignment_mode      text NOT NULL DEFAULT 'manual' CHECK (assignment_mode IN ('manual','least_busy')),
  holidays             date[] NOT NULL DEFAULT '{}',
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE business_hours (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  weekday      smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = Sunday (Postgres dow)
  start_minute smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute   smallint NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  CHECK (start_minute < end_minute)
);
CREATE INDEX business_hours_tenant_idx ON business_hours (tenant_id, weekday, start_minute);

CREATE TABLE agent_availability (
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL,
  status     text NOT NULL DEFAULT 'offline' CHECK (status IN ('online','away','offline')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

-- ---- tickets -------------------------------------------------------------------------------------
CREATE TABLE ticket_counters (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  last      bigint NOT NULL DEFAULT 0
);

CREATE TABLE tickets (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  number           bigint NOT NULL,
  title            text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description      text NOT NULL DEFAULT '' CHECK (char_length(description) <= 8000),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','waiting','resolved','closed')),
  priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  assignee_user_id uuid,
  contact_id       uuid,
  conversation_id  uuid,
  due_at           timestamptz,
  sla_breached_at  timestamptz,
  resolved_at      timestamptz,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, assignee_user_id) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
);
CREATE INDEX tickets_list_idx ON tickets (tenant_id, created_at DESC, id);
CREATE INDEX tickets_status_idx ON tickets (tenant_id, status, updated_at DESC);
CREATE INDEX tickets_assignee_idx ON tickets (tenant_id, assignee_user_id) WHERE assignee_user_id IS NOT NULL;
CREATE INDEX tickets_contact_idx ON tickets (tenant_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX tickets_conversation_idx ON tickets (tenant_id, conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX tickets_sla_idx ON tickets (due_at) WHERE sla_breached_at IS NULL AND status NOT IN ('resolved','closed');

CREATE TABLE ticket_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  ticket_id     uuid NOT NULL,
  actor_user_id uuid,
  type          text NOT NULL CHECK (type IN ('created','status_changed','priority_changed','assigned','updated','comment','sla_breached','bulk')),
  data          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES tickets (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX ticket_events_ticket_idx ON ticket_events (tenant_id, ticket_id, created_at, id);

-- ---- transactions --------------------------------------------------------------------------------
CREATE TABLE transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  external_id     text CHECK (external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 200),
  source          text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','webhook')),
  amount_cents    bigint NOT NULL CHECK (amount_cents BETWEEN -1000000000000 AND 1000000000000),
  currency        text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status          text NOT NULL DEFAULT 'completed' CHECK (status IN ('pending','completed','failed','refunded')),
  description     text CHECK (description IS NULL OR char_length(description) <= 1000),
  contact_id      uuid,
  conversation_id uuid,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
);
CREATE UNIQUE INDEX transactions_external_uniq ON transactions (tenant_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX transactions_list_idx ON transactions (tenant_id, occurred_at DESC, id);
CREATE INDEX transactions_contact_idx ON transactions (tenant_id, contact_id) WHERE contact_id IS NOT NULL;

CREATE TABLE transaction_webhook_endpoints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  name             text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  secret_encrypted text NOT NULL,
  enabled          boolean NOT NULL DEFAULT true,
  created_by       uuid,
  last_used_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX transaction_webhook_endpoints_tenant_idx ON transaction_webhook_endpoints (tenant_id, created_at);

-- ---- calendar + bookings -------------------------------------------------------------------------
CREATE TABLE calendar_connections (
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  provider              text NOT NULL CHECK (provider IN ('google')),
  account_email         text,
  calendar_id           text NOT NULL DEFAULT 'primary',
  -- AES-256-GCM envelope (ENCRYPTION_KEY): { accessToken, refreshToken, expiresAt }. Never plaintext.
  credentials_encrypted text NOT NULL,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active','error')),
  last_error            text,
  connected_by          uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, provider)
);

CREATE TABLE bookings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  status            text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled','failed')),
  title             text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  start_at          timestamptz NOT NULL,
  end_at            timestamptz NOT NULL,
  timezone          text,
  contact_id        uuid,
  conversation_id   uuid,
  attendee_email    text CHECK (attendee_email IS NULL OR char_length(attendee_email) <= 254),
  notes             text CHECK (notes IS NULL OR char_length(notes) <= 2000),
  provider          text CHECK (provider IS NULL OR provider IN ('google')),
  external_event_id text,
  event_url         text,
  failure_reason    text,
  cancelled_at      timestamptz,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (end_at > start_at),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX bookings_start_idx ON bookings (tenant_id, start_at, id);
CREATE INDEX bookings_created_idx ON bookings (tenant_id, created_at DESC, id);
CREATE INDEX bookings_contact_idx ON bookings (tenant_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX bookings_conversation_idx ON bookings (tenant_id, conversation_id) WHERE conversation_id IS NOT NULL;

-- ---- canned responses, tags ----------------------------------------------------------------------
CREATE TABLE canned_responses (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  shortcut   text NOT NULL CHECK (shortcut ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
  title      text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  content    text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 4000),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, shortcut),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users (tenant_id, id)
);

CREATE TABLE tags (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  color      text NOT NULL DEFAULT '#6b7280' CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX tags_name_uniq ON tags (tenant_id, lower(name));

CREATE TABLE taggables (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  tag_id        uuid NOT NULL,
  resource_type text NOT NULL CHECK (resource_type IN ('conversation','contact','ticket')),
  resource_id   uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, tag_id, resource_type, resource_id),
  FOREIGN KEY (tenant_id, tag_id) REFERENCES tags (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX taggables_resource_idx ON taggables (tenant_id, resource_type, resource_id);

-- ---- notifications -------------------------------------------------------------------------------
CREATE TABLE notifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  user_id        uuid NOT NULL,
  type           text NOT NULL CHECK (char_length(type) BETWEEN 1 AND 60),
  title          text NOT NULL CHECK (char_length(title) <= 300),
  body           text CHECK (body IS NULL OR char_length(body) <= 2000),
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at        timestamptz,
  email_status   text NOT NULL DEFAULT 'none' CHECK (email_status IN ('none','pending','sent','failed')),
  email_attempts integer NOT NULL DEFAULT 0,
  email_error    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX notifications_user_idx ON notifications (tenant_id, user_id, created_at DESC, id);
CREATE INDEX notifications_unread_idx ON notifications (tenant_id, user_id) WHERE read_at IS NULL;
CREATE INDEX notifications_email_idx ON notifications (created_at) WHERE email_status = 'pending';

CREATE TABLE notification_prefs (
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  user_id       uuid NOT NULL,
  email_enabled boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id) ON DELETE CASCADE
);

-- ---- extend handoffs (created by 0200) for the Needs Attention queue -----------------------------
ALTER TABLE handoffs
  ADD COLUMN IF NOT EXISTS assigned_user_id uuid,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by uuid,
  ADD COLUMN IF NOT EXISTS resolution_note text CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 2000),
  ADD COLUMN IF NOT EXISTS out_of_hours boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS handoffs_queue_idx ON handoffs (tenant_id, created_at, id) WHERE resolved_at IS NULL;

-- ---- RLS -----------------------------------------------------------------------------------------
DO $$
DECLARE t text; owner_role text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['ops_settings','business_hours','agent_availability','ticket_counters','tickets','ticket_events',
                           'transactions','transaction_webhook_endpoints','calendar_connections','bookings',
                           'canned_responses','tags','taggables','notifications','notification_prefs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, owner_role);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO yulona_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON ops_settings, ticket_counters, agent_availability, notification_prefs, calendar_connections TO yulona_app;
GRANT DELETE ON calendar_connections TO yulona_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON business_hours, tickets, transactions, transaction_webhook_endpoints, canned_responses,
  tags, taggables TO yulona_app;
GRANT SELECT, INSERT ON ticket_events TO yulona_app;
GRANT SELECT, INSERT, UPDATE ON bookings, notifications TO yulona_app;

-- ---- business hours ------------------------------------------------------------------------------
-- No configured windows => always open. Unknown timezone => UTC.
CREATE FUNCTION ops_in_business_hours(p_tenant uuid, p_at timestamptz DEFAULT now()) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE v_tz text; v_local timestamp; v_dow integer; v_mins integer; v_hols date[];
BEGIN
  SELECT timezone, holidays INTO v_tz, v_hols FROM ops_settings WHERE tenant_id = p_tenant;
  v_tz := COALESCE(v_tz, 'UTC');
  BEGIN
    v_local := p_at AT TIME ZONE v_tz;
  EXCEPTION WHEN OTHERS THEN
    v_local := p_at AT TIME ZONE 'UTC';
  END;
  IF v_hols IS NOT NULL AND v_local::date = ANY (v_hols) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM business_hours WHERE tenant_id = p_tenant) THEN RETURN true; END IF;
  v_dow := extract(dow FROM v_local)::integer;
  v_mins := extract(hour FROM v_local)::integer * 60 + extract(minute FROM v_local)::integer;
  RETURN EXISTS (SELECT 1 FROM business_hours
                 WHERE tenant_id = p_tenant AND weekday = v_dow AND v_mins >= start_minute AND v_mins < end_minute);
END $$;

-- ---- notification helper (honours the per-user email preference) ----------------------------------
CREATE FUNCTION ops_notify(p_tenant uuid, p_user uuid, p_type text, p_title text, p_body text, p_data jsonb, p_email boolean)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO notifications (tenant_id, user_id, type, title, body, data, email_status)
  VALUES (p_tenant, p_user, p_type, left(p_title, 300), left(p_body, 2000), COALESCE(p_data, '{}'::jsonb),
          CASE WHEN p_email AND COALESCE((SELECT email_enabled FROM notification_prefs WHERE tenant_id = p_tenant AND user_id = p_user), true)
               THEN 'pending' ELSE 'none' END);
END $$;

-- ---- handoff routing: out-of-hours flag, least-busy assignment, notifications --------------------
CREATE FUNCTION handoffs_ops_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.out_of_hours := NOT ops_in_business_hours(NEW.tenant_id, now());
  RETURN NEW;
END $$;
CREATE TRIGGER handoffs_ops_before_insert BEFORE INSERT ON handoffs FOR EACH ROW EXECUTE FUNCTION handoffs_ops_before_insert();

CREATE FUNCTION handoffs_ops_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s ops_settings%ROWTYPE; v_assignee uuid; u record; v_title text; v_data jsonb;
BEGIN
  SELECT * INTO s FROM ops_settings WHERE tenant_id = NEW.tenant_id;
  v_title := CASE NEW.type WHEN 'system_failure' THEN 'System failure needs a person'
                           WHEN 'stage' THEN 'Qualified lead ready for a person'
                           ELSE 'AI is unsure and needs a person' END;
  v_data := jsonb_build_object('handoffId', NEW.id, 'conversationId', NEW.conversation_id, 'type', NEW.type, 'outOfHours', NEW.out_of_hours);
  IF COALESCE(s.assignment_mode, 'manual') = 'least_busy' THEN
    SELECT a.user_id INTO v_assignee
    FROM agent_availability a
    JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.user_id AND u.status = 'active' AND u.role IN ('owner','admin','agent')
    WHERE a.tenant_id = NEW.tenant_id AND a.status = 'online'
    ORDER BY (SELECT count(*) FROM conversations c WHERE c.tenant_id = a.tenant_id AND c.assigned_user_id = a.user_id AND c.status <> 'resolved') ASC,
             a.updated_at ASC
    LIMIT 1;
  END IF;
  IF v_assignee IS NOT NULL THEN
    UPDATE handoffs SET assigned_user_id = v_assignee WHERE id = NEW.id;
    UPDATE conversations SET assigned_user_id = v_assignee, updated_at = now()
    WHERE tenant_id = NEW.tenant_id AND id = NEW.conversation_id AND assigned_user_id IS NULL;
    PERFORM ops_notify(NEW.tenant_id, v_assignee, 'handoff.assigned', v_title, NEW.reason, v_data, true);
  ELSE
    FOR u IN SELECT id FROM users WHERE tenant_id = NEW.tenant_id AND status = 'active' AND role IN ('owner','admin','agent') LOOP
      PERFORM ops_notify(NEW.tenant_id, u.id, 'handoff.requested', v_title, NEW.reason, v_data, true);
    END LOOP;
  END IF;
  IF NEW.out_of_hours AND COALESCE(s.out_of_hours_mode, 'ai_only') = 'message' THEN
    INSERT INTO messages (tenant_id, conversation_id, sender_type, content, metadata)
    VALUES (NEW.tenant_id, NEW.conversation_id, 'ai',
            COALESCE(s.out_of_hours_message, 'Our team is currently offline. We have your details and will get back to you as soon as we are open.'),
            jsonb_build_object('event', 'out_of_hours', 'handoffId', NEW.id));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER handoffs_ops_after_insert AFTER INSERT ON handoffs FOR EACH ROW EXECUTE FUNCTION handoffs_ops_after_insert();

-- ---- SLA breach scan (all tenants; SECURITY DEFINER because the worker has no tenant context) -----
CREATE FUNCTION ops_sla_scan() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r record; u record; n integer := 0; v_data jsonb;
BEGIN
  FOR r IN
    SELECT id, tenant_id, number, title, assignee_user_id FROM tickets
    WHERE sla_breached_at IS NULL AND due_at IS NOT NULL AND due_at < now() AND status NOT IN ('resolved','closed')
    ORDER BY due_at LIMIT 500 FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE tickets SET sla_breached_at = now(), updated_at = now() WHERE id = r.id;
    INSERT INTO ticket_events (tenant_id, ticket_id, type, data) VALUES (r.tenant_id, r.id, 'sla_breached', '{}'::jsonb);
    v_data := jsonb_build_object('ticketId', r.id, 'number', r.number);
    IF r.assignee_user_id IS NOT NULL THEN
      PERFORM ops_notify(r.tenant_id, r.assignee_user_id, 'ticket.sla_breached', 'SLA breached on #' || r.number, r.title, v_data, true);
    ELSE
      FOR u IN SELECT id FROM users WHERE tenant_id = r.tenant_id AND status = 'active' AND role IN ('owner','admin') LOOP
        PERFORM ops_notify(r.tenant_id, u.id, 'ticket.sla_breached', 'SLA breached on #' || r.number, r.title, v_data, true);
      END LOOP;
    END IF;
    n := n + 1;
  END LOOP;
  RETURN n;
END $$;

-- ---- notification email dispatch (worker, no tenant context) -------------------------------------
CREATE FUNCTION ops_notifications_claim_email(p_limit integer)
RETURNS TABLE (id uuid, tenant_id uuid, to_email text, to_name text, type text, title text, body text, attempts integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH picked AS (
    SELECT n.id FROM notifications n
    WHERE n.email_status = 'pending' AND n.email_attempts < 5
    ORDER BY n.created_at LIMIT GREATEST(1, LEAST(p_limit, 100)) FOR UPDATE SKIP LOCKED
  ), bumped AS (
    UPDATE notifications n SET email_attempts = n.email_attempts + 1 FROM picked WHERE n.id = picked.id
    RETURNING n.id, n.tenant_id, n.user_id, n.type, n.title, n.body, n.email_attempts
  )
  SELECT b.id, b.tenant_id, u.email, u.name, b.type, b.title, b.body, b.email_attempts
  FROM bumped b JOIN users u ON u.tenant_id = b.tenant_id AND u.id = b.user_id AND u.status = 'active'
$$;

CREATE FUNCTION ops_notification_email_done(p_id uuid, p_ok boolean, p_error text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE notifications SET
    email_status = CASE WHEN p_ok THEN 'sent' WHEN email_attempts >= 5 THEN 'failed' ELSE 'pending' END,
    email_error = CASE WHEN p_ok THEN NULL ELSE left(p_error, 500) END
  WHERE id = p_id
$$;

-- ---- inbound transaction webhook: the ONLY cross-tenant read of the endpoint table ----------------
CREATE FUNCTION ops_txn_endpoint_resolve(p_id uuid)
RETURNS TABLE (tenant_id uuid, secret_encrypted text, enabled boolean, tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.tenant_id, e.secret_encrypted, e.enabled, t.status
  FROM transaction_webhook_endpoints e JOIN tenants t ON t.id = e.tenant_id WHERE e.id = p_id
$$;

REVOKE ALL ON FUNCTION ops_sla_scan(), ops_notifications_claim_email(integer), ops_notification_email_done(uuid,boolean,text),
  ops_txn_endpoint_resolve(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ops_sla_scan(), ops_notifications_claim_email(integer), ops_notification_email_done(uuid,boolean,text),
  ops_txn_endpoint_resolve(uuid) TO yulona_app;
