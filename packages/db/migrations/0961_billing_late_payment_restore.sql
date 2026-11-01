-- Wave 5 / C: a successful invoice payment after the grace window expired restores the paid plan (previously only the
-- subscription_set path did, leaving a paying workspace on Free until customer.subscription.updated arrived).
CREATE OR REPLACE FUNCTION billing_apply_event(
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
    -- a late payment also restores the paid plan when the grace window had already downgraded the workspace
    UPDATE billing_customers SET status = 'active', grace_until = NULL, updated_at = now() WHERE tenant_id = v_t AND status = 'past_due'
      RETURNING plan_key INTO v_plan;
    IF FOUND AND v_plan IS NOT NULL AND v_plan <> 'free' THEN v_new_plan := v_plan; END IF;
  END IF;

  IF v_new_plan IS NOT NULL THEN
    UPDATE tenants SET plan_key = v_new_plan, updated_at = now() WHERE id = v_t AND status <> 'deleted' AND plan_key <> v_new_plan;
  END IF;
  INSERT INTO audit_logs (tenant_id, action, resource_type, resource_id, metadata)
    VALUES (v_t, 'billing.' || p_action, 'tenant', v_t::text,
            jsonb_build_object('eventId', p_event_id, 'type', p_type, 'status', p_status, 'plan', p_plan));
  RETURN 'applied';
END $$;
