-- Wave 7: the transactions feature is removed (data is intentionally dropped, no archive).
-- Drops the resolver function and both tables (policies, indexes and triggers go with them), then
-- re-creates the GDPR erase function from 0500 without 'transactions' in the retained-tables report.
DROP FUNCTION IF EXISTS ops_txn_endpoint_resolve(uuid);
DROP TABLE IF EXISTS transaction_webhook_endpoints, transactions;

CREATE OR REPLACE FUNCTION gdpr_erase_contact(p_tenant uuid, p_contact uuid) RETURNS jsonb
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
  -- (tickets/bookings may be subject to legal retention).
  FOREACH t IN ARRAY ARRAY['tickets','bookings'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL AND EXISTS (
         SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t AND column_name = 'contact_id') THEN
      EXECUTE format('SELECT count(*) FROM %I WHERE tenant_id = $1 AND contact_id = ANY($2)', t) INTO cnt USING p_tenant, ids;
      IF cnt > 0 THEN retained := retained || jsonb_build_object('table', t, 'rows', cnt); END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('contacts', cardinality(ids), 'messagesRedacted', n_msg, 'identitiesDeleted', n_id,
                            'conversations', cardinality(convs), 'retained', retained);
END $$;
