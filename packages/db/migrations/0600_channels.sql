-- Channels domain (migration range 0600-0699): connection health, webhook replay protection,
-- outbound delivery tracking, merge suggestions, pre-auth connection lookup, channel.send trigger.
-- Run as the owner role.

ALTER TABLE channel_connections
  ADD COLUMN last_health_at    timestamptz,
  ADD COLUMN last_health_ok    boolean,
  ADD COLUMN last_health_error text;

-- Replay protection: one row per (connection, provider event id). Pruned opportunistically (> 7 days).
CREATE TABLE channel_webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  connection_id uuid NOT NULL,
  event_id      text NOT NULL CHECK (char_length(event_id) <= 300),
  received_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, event_id),
  FOREIGN KEY (tenant_id, connection_id) REFERENCES channel_connections (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX channel_webhook_events_received_idx ON channel_webhook_events (tenant_id, received_at);

-- Outbound delivery state per message (also the idempotency record for the channel.send job).
CREATE TABLE channel_deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  message_id          uuid NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL,
  connection_id       uuid,
  channel             text NOT NULL,
  status              text NOT NULL CHECK (status IN ('sent','failed')),
  external_message_id text,
  error               text,
  used_template       boolean NOT NULL DEFAULT false,
  attempts            integer NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id)
);
CREATE INDEX channel_deliveries_conv_idx ON channel_deliveries (tenant_id, conversation_id, created_at);

CREATE TABLE contact_merge_suggestions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id),
  primary_contact_id uuid NOT NULL,
  other_contact_id   uuid NOT NULL,
  reason             text NOT NULL CHECK (reason IN ('same_email','same_phone','same_name')),
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dismissed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (primary_contact_id <> other_contact_id),
  UNIQUE (tenant_id, primary_contact_id, other_contact_id),
  FOREIGN KEY (tenant_id, primary_contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, other_contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX contact_merge_suggestions_idx ON contact_merge_suggestions (tenant_id, status, created_at DESC);

DO $$
DECLARE t text; owner_role text := current_user;
BEGIN
  FOREACH t IN ARRAY ARRAY['channel_webhook_events','channel_deliveries','contact_merge_suggestions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY owner_all ON %I FOR ALL TO %I USING (true) WITH CHECK (true)', t, owner_role);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I FOR ALL TO yulona_app USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, DELETE ON channel_webhook_events TO yulona_app;
GRANT SELECT, INSERT, UPDATE ON channel_deliveries TO yulona_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON contact_merge_suggestions TO yulona_app;

-- Pre-auth: webhook receivers are public and only know the connection id. The ONLY cross-tenant read
-- of channel_connections; returns the minimum the receiver needs (ciphertext, never plaintext).
CREATE FUNCTION channel_connection_resolve(p_id uuid)
RETURNS TABLE (connection_id uuid, tenant_id uuid, channel text, status text, agent_id uuid,
               credentials_encrypted text, tenant_status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.tenant_id, c.channel, c.status, c.agent_id, c.credentials_encrypted, t.status
  FROM channel_connections c JOIN tenants t ON t.id = c.tenant_id
  WHERE c.id = p_id
$$;
REVOKE ALL ON FUNCTION channel_connection_resolve(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION channel_connection_resolve(uuid) TO yulona_app;

-- Every AI/human reply on a non-widget conversation is delivered by the `channel.send` job, whichever
-- writer (API, AI worker) inserted it. Runs as the inserting role (tenant GUC set, RLS applies).
CREATE FUNCTION messages_enqueue_channel_send() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_channel text;
BEGIN
  SELECT channel INTO v_channel FROM conversations WHERE tenant_id = NEW.tenant_id AND id = NEW.conversation_id;
  IF v_channel IS NOT NULL AND v_channel <> 'widget' THEN
    INSERT INTO jobs (tenant_id, name, payload, max_attempts)
    VALUES (NEW.tenant_id, 'channel.send',
            jsonb_build_object('tenantId', NEW.tenant_id, 'messageId', NEW.id), 6);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER messages_enqueue_channel_send AFTER INSERT ON messages
  FOR EACH ROW WHEN (NEW.sender_type IN ('ai','human')) EXECUTE FUNCTION messages_enqueue_channel_send();
