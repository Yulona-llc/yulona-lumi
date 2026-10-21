-- 0400's handoff trigger declared a record variable `u` that shadowed the `users u` alias inside the least_busy
-- assignment query (Postgres error 55000 as soon as assignment_mode = 'least_busy'). Recreate with a distinct name.
CREATE OR REPLACE FUNCTION handoffs_ops_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s ops_settings%ROWTYPE; v_assignee uuid; rec record; v_title text; v_data jsonb;
BEGIN
  SELECT * INTO s FROM ops_settings WHERE tenant_id = NEW.tenant_id;
  v_title := CASE NEW.type WHEN 'system_failure' THEN 'System failure needs a person'
                           WHEN 'stage' THEN 'Qualified lead ready for a person'
                           ELSE 'AI is unsure and needs a person' END;
  v_data := jsonb_build_object('handoffId', NEW.id, 'conversationId', NEW.conversation_id, 'type', NEW.type, 'outOfHours', NEW.out_of_hours);
  IF COALESCE(s.assignment_mode, 'manual') = 'least_busy' THEN
    SELECT a.user_id INTO v_assignee
    FROM agent_availability a
    JOIN users usr ON usr.tenant_id = a.tenant_id AND usr.id = a.user_id AND usr.status = 'active' AND usr.role IN ('owner','admin','agent')
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
    FOR rec IN SELECT id FROM users WHERE tenant_id = NEW.tenant_id AND status = 'active' AND role IN ('owner','admin','agent') LOOP
      PERFORM ops_notify(NEW.tenant_id, rec.id, 'handoff.requested', v_title, NEW.reason, v_data, true);
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
