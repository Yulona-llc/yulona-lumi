-- Wave 5 / C: the $49/month paid plan (`pro`) gets its token-to-credit mapping.
-- At the seeded default rate (0.25 credits in / 1.0 credits out per 1k tokens):
--   14,000k prompt tokens x 0.25 + 1,480k completion tokens x 1.0 = 3,500 + 1,480 = 4,980 credits  (15,480,000 tokens).
-- Credits stay the single pooled meter; llm_tokens_monthly is display-only. Rates and allowances remain editable by the
-- platform admin. `free`, `enterprise` and `self_hosted` are untouched. Plan key stays `pro` (relabelled in the UI).
INSERT INTO plan_limits (plan_key, metric, limit_value) VALUES
  ('pro', 'llm_credits_monthly', 4980),
  ('pro', 'llm_tokens_monthly', 15480000)
ON CONFLICT (plan_key, metric) DO UPDATE SET limit_value = EXCLUDED.limit_value;
