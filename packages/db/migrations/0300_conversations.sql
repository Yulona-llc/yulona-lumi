-- Conversations domain (migration range 0300-0399): contacts, identities, widgets, widget sessions,
-- conversations, messages, channel connections. Run as the owner role.
-- agent_id columns intentionally have no FK: the agents table lives in another migration range.

CREATE TABLE contacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  name              text CHECK (name IS NULL OR char_length(name) <= 200),
  email             text CHECK (email IS NULL OR char_length(email) <= 254),
  phone             text CHECK (phone IS NULL OR char_length(phone) <= 40),
  custom_attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  merged_into       uuid,
  first_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, merged_into) REFERENCES contacts (tenant_id, id)
);
CREATE INDEX contacts_tenant_created_idx ON contacts (tenant_id, created_at DESC, id);
CREATE INDEX contacts_tenant_email_idx ON contacts (tenant_id, lower(email)) WHERE email IS NOT NULL;

CREATE TABLE contact_identities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  contact_id  uuid NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('widget','whatsapp','facebook','instagram','telegram','slack')),
  external_id text NOT NULL CHECK (char_length(external_id) <= 200),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, external_id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX contact_identities_contact_idx ON contact_identities (tenant_id, contact_id);

CREATE TABLE contact_merges (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  primary_contact_id uuid NOT NULL,
  merged_contact_id  uuid NOT NULL,
  merged_by          uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, primary_contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, merged_contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, merged_by) REFERENCES users (tenant_id, id)
);
CREATE INDEX contact_merges_tenant_idx ON contact_merges (tenant_id, primary_contact_id);

CREATE TABLE widgets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  widget_key      text NOT NULL UNIQUE,
  agent_id        uuid,
  enabled         boolean NOT NULL DEFAULT true,
  config          jsonb NOT NULL DEFAULT '{}'::jsonb,
  prechat         jsonb NOT NULL DEFAULT '{"enabled":false,"fields":[]}'::jsonb,
  allowed_domains text[] NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX widgets_tenant_idx ON widgets (tenant_id, created_at);

CREATE TABLE channel_connections (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  channel       text NOT NULL CHECK (channel IN ('whatsapp','facebook','instagram','telegram','slack')),
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  external_id   text,
  agent_id      uuid,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','error')),
  -- AES-256-GCM envelope (app-level, key from ENCRYPTION_KEY); never plaintext.
  credentials_encrypted text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX channel_connections_tenant_idx ON channel_connections (tenant_id, channel);

CREATE TABLE conversations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id),
  contact_id               uuid NOT NULL,
  channel                  text NOT NULL DEFAULT 'widget' CHECK (channel IN ('widget','whatsapp','facebook','instagram','telegram','slack')),
  widget_id                uuid,
  channel_connection_id    uuid,
  agent_id                 uuid,
  -- open: active; pending_human: needs a human (AI stopped); resolved: closed.
  status                   text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending_human','resolved')),
  -- ai: AI answers; human: a person took over (AI job is not enqueued).
  handler                  text NOT NULL DEFAULT 'ai' CHECK (handler IN ('ai','human')),
  assigned_user_id         uuid,
  metadata                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_message_at          timestamptz NOT NULL DEFAULT now(),
  last_message_preview     text,
  last_customer_message_at timestamptz,
  resolved_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, widget_id) REFERENCES widgets (tenant_id, id) ON DELETE SET NULL (widget_id),
  FOREIGN KEY (tenant_id, channel_connection_id) REFERENCES channel_connections (tenant_id, id) ON DELETE SET NULL (channel_connection_id),
  FOREIGN KEY (tenant_id, assigned_user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX conversations_inbox_idx ON conversations (tenant_id, last_message_at DESC, id);
CREATE INDEX conversations_status_idx ON conversations (tenant_id, status, last_message_at DESC);
CREATE INDEX conversations_contact_idx ON conversations (tenant_id, contact_id, created_at DESC);
CREATE INDEX conversations_assignee_idx ON conversations (tenant_id, assigned_user_id) WHERE assigned_user_id IS NOT NULL;

CREATE TABLE messages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  conversation_id   uuid NOT NULL,
  sender_type       text NOT NULL CHECK (sender_type IN ('contact','ai','human','system','note')),
  sender_user_id    uuid,
  content           text NOT NULL DEFAULT '' CHECK (char_length(content) <= 8000),
  ui                jsonb,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- client-generated idempotency key (widget offline queue retries)
  client_message_id text CHECK (client_message_id IS NULL OR char_length(client_message_id) <= 64),
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id),
  FOREIGN KEY (tenant_id, sender_user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX messages_conv_idx ON messages (tenant_id, conversation_id, created_at, id);
CREATE UNIQUE INDEX messages_client_id_uniq ON messages (conversation_id, client_message_id) WHERE client_message_id IS NOT NULL;

CREATE TABLE widget_sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  widget_id       uuid NOT NULL,
  conversation_id uuid NOT NULL,
  contact_id      uuid NOT NULL,
  origin          text,
  ip              text,
  user_agent      text,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, widget_id) REFERENCES widgets (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id)
);
CREATE INDEX widget_sessions_conv_idx ON widget_sessions (tenant_id, conversation_id);

-- ---- RLS --------------------------------------------------------------------------------------
DO $$
DECLARE t text; owner_role text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts','contact_identities','contact_merges','widgets','channel_connections',
                           'conversations','messages','widget_sessions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, owner_role);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO yulona_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON contacts TO yulona_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_identities TO yulona_app;
GRANT SELECT, INSERT ON contact_merges TO yulona_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON widgets TO yulona_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON channel_connections TO yulona_app;
GRANT SELECT, INSERT, UPDATE ON conversations TO yulona_app;
GRANT SELECT, INSERT ON messages TO yulona_app;
GRANT SELECT, INSERT, UPDATE ON widget_sessions TO yulona_app;

-- ---- Pre-auth: resolve a public widget key -> tenant. The ONLY cross-tenant read of widgets. ----
CREATE FUNCTION widget_resolve(p_key text)
RETURNS TABLE (widget_id uuid, tenant_id uuid, name text, enabled boolean, allowed_domains text[],
               config jsonb, prechat jsonb, agent_id uuid, tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT w.id, w.tenant_id, w.name, w.enabled, w.allowed_domains, w.config, w.prechat, w.agent_id, t.status
  FROM widgets w JOIN tenants t ON t.id = w.tenant_id
  WHERE w.widget_key = p_key
$$;
REVOKE ALL ON FUNCTION widget_resolve(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION widget_resolve(text) TO yulona_app;

-- ---- Keep conversation summary current for every writer (API, AI worker, future channels) -----
CREATE FUNCTION messages_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.sender_type <> 'note' AND NEW.sender_type <> 'system' THEN
    UPDATE conversations SET
      last_message_at = NEW.created_at,
      last_message_preview = left(NULLIF(NEW.content, ''), 140),
      last_customer_message_at = CASE WHEN NEW.sender_type = 'contact' THEN NEW.created_at ELSE last_customer_message_at END,
      updated_at = now()
    WHERE tenant_id = NEW.tenant_id AND id = NEW.conversation_id;
    UPDATE contacts SET last_seen_at = NEW.created_at
    WHERE NEW.sender_type = 'contact' AND tenant_id = NEW.tenant_id
      AND id = (SELECT contact_id FROM conversations WHERE tenant_id = NEW.tenant_id AND id = NEW.conversation_id);
  END IF;
  -- Realtime: payload carries ids only (pg_notify limit 8000 bytes); listeners hydrate under RLS.
  PERFORM pg_notify('yulona_rt', json_build_object('t', NEW.tenant_id, 'c', NEW.conversation_id, 'e', 'message.created', 'id', NEW.id)::text);
  RETURN NULL;
END $$;
CREATE TRIGGER messages_after_insert AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION messages_after_insert();

CREATE FUNCTION conversations_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.handler IS DISTINCT FROM OLD.handler
     OR NEW.assigned_user_id IS DISTINCT FROM OLD.assigned_user_id THEN
    PERFORM pg_notify('yulona_rt', json_build_object('t', NEW.tenant_id, 'c', NEW.id, 'e', 'conversation.updated', 'id', NEW.id)::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER conversations_notify AFTER INSERT OR UPDATE ON conversations FOR EACH ROW EXECUTE FUNCTION conversations_notify();
