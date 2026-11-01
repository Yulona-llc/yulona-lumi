import { withTenant, type Db, type Tx } from "@yulona/db";
import { AppError } from "../errors";

export const LIMIT_METRICS = ["seats", "agents", "widgets", "api_keys", "monthly_conversations", "storage_mb", "llm_tokens_monthly", "llm_credits_monthly", "copilot_credits_monthly"] as const;
export type LimitMetric = (typeof LIMIT_METRICS)[number];

const MONTHLY: ReadonlySet<LimitMetric> = new Set(["monthly_conversations", "llm_tokens_monthly", "llm_credits_monthly", "copilot_credits_monthly"]);
export const GAUGE_PERIOD = "1970-01-01";

export interface LimitCheck {
  metric: LimitMetric;
  /** null = unlimited */
  limit: number | null;
  used: number;
  remaining: number | null;
  /** true if `used + increment` fits in the limit */
  allowed: boolean;
  /** true when usage is >= 80% of the limit (grace/warning UX) */
  warning: boolean;
}

function inTx<T>(db: Db | Tx, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return typeof (db as Tx).savepoint === "function" ? fn(db as Tx) : withTenant(db as Db, tenantId, fn);
}

async function usedOf(tx: Tx, tenantId: string, metric: LimitMetric): Promise<number> {
  switch (metric) {
    case "seats": {
      const [r] = await tx<{ n: number }[]>`
        SELECT (SELECT count(*) FROM users WHERE tenant_id = ${tenantId} AND status = 'active')
             + (SELECT count(*) FROM invitations WHERE tenant_id = ${tenantId} AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()) AS n`;
      return Number(r!.n);
    }
    case "agents": {
      const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM agents WHERE tenant_id = ${tenantId} AND status <> 'archived'`;
      return Number(r!.n);
    }
    case "api_keys": {
      const [r] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM api_keys WHERE tenant_id = ${tenantId} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`;
      return Number(r!.n);
    }
    // Live counts from the source tables (billing-admin), combined with any explicit counter via GREATEST so
    // `incrementUsage` callers keep working and uncounted creation paths (channels, imports) cannot drift.
    case "widgets": {
      const [r] = await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM widgets WHERE tenant_id = ${tenantId}`;
      return Math.max(Number(r!.n), await counterOf(tx, tenantId, metric));
    }
    case "monthly_conversations": {
      const [r] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM conversations WHERE tenant_id = ${tenantId} AND created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
      return Math.max(Number(r!.n), await counterOf(tx, tenantId, metric));
    }
    case "storage_mb": {
      const [r] = await tx<{ n: string }[]>`SELECT COALESCE(ceil(sum(size_bytes) / 1048576.0), 0)::bigint AS n FROM knowledge_sources WHERE tenant_id = ${tenantId}`;
      return Math.max(Number(r!.n), await counterOf(tx, tenantId, metric));
    }
    // Tokens this UTC month: the per-call events and the daily counters are written together; take the larger so
    // rows that predate the events table (or a missing event) never under-report.
    case "llm_tokens_monthly": {
      const [r] = await tx<{ n: string }[]>`
        SELECT GREATEST(
          (SELECT COALESCE(sum(prompt_tokens + completion_tokens), 0) FROM ai_usage_events
            WHERE tenant_id = ${tenantId} AND day >= date_trunc('month', now() AT TIME ZONE 'UTC')::date),
          (SELECT COALESCE(sum(amount), 0) FROM ai_usage
            WHERE tenant_id = ${tenantId} AND kind IN ('llm_prompt_tokens','llm_completion_tokens') AND day >= date_trunc('month', now() AT TIME ZONE 'UTC')::date)
        )::bigint AS n`;
      return Math.max(Number(r!.n), await counterOf(tx, tenantId, metric));
    }
    // Whole credits drawn from the monthly allowance this period (top-up spend is not counted against the plan).
    case "llm_credits_monthly": {
      const [r] = await tx<{ n: string }[]>`
        SELECT COALESCE(ceil(used_micro / 1000000.0), 0)::bigint AS n FROM tenant_credits
        WHERE tenant_id = ${tenantId} AND period = (date_trunc('month', now() AT TIME ZONE 'UTC'))::date`;
      return Number(r?.n ?? 0);
    }
    // Whole credits the Ask Lumi copilot used this UTC month (its own allowance; never drawn from chat credits).
    case "copilot_credits_monthly": {
      const [r] = await tx<{ n: string }[]>`
        SELECT COALESCE(ceil(sum(credits_micro) / 1000000.0), 0)::bigint AS n FROM ai_usage_events
        WHERE tenant_id = ${tenantId} AND source = 'copilot' AND at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
      return Number(r?.n ?? 0);
    }
    default:
      return counterOf(tx, tenantId, metric);
  }
}

async function counterOf(tx: Tx, tenantId: string, metric: LimitMetric): Promise<number> {
  const period = MONTHLY.has(metric) ? new Date().toISOString().slice(0, 7) + "-01" : GAUGE_PERIOD;
  const [r] = await tx<{ value: string }[]>`
    SELECT value FROM usage_counters WHERE tenant_id = ${tenantId} AND metric = ${metric} AND period = ${period}::date`;
  return Number(r?.value ?? 0);
}

/**
 * Plan-limit check for a tenant. `db` may be a Db (opens a tenant tx) or a Tx from `withTenant`.
 * `increment` is how many units the caller is about to add (default 1).
 */
export async function checkLimit(db: Db | Tx, tenantId: string, metric: LimitMetric, increment = 1): Promise<LimitCheck> {
  return inTx(db, tenantId, async (tx) => {
    const [row] = await tx<{ limitValue: string | null; found: boolean }[]>`
      SELECT pl.limit_value, true AS found FROM tenants t
      JOIN plan_limits pl ON pl.plan_key = t.plan_key AND pl.metric = ${metric}
      WHERE t.id = ${tenantId}`;
    const limit = row && row.limitValue !== null ? Number(row.limitValue) : null;
    const used = await usedOf(tx, tenantId, metric);
    return {
      metric, limit, used,
      remaining: limit === null ? null : Math.max(0, limit - used),
      allowed: limit === null || used + increment <= limit,
      warning: limit !== null && limit > 0 && used >= limit * 0.8,
    };
  });
}

/** Throws a 402 `plan_limit_exceeded` AppError when the tenant cannot add `increment` more. */
export async function assertWithinLimit(db: Db | Tx, tenantId: string, metric: LimitMetric, increment = 1): Promise<LimitCheck> {
  const r = await checkLimit(db, tenantId, metric, increment);
  if (!r.allowed) throw new AppError(402, "plan_limit_exceeded", `Plan limit reached for ${metric}`, { metric, limit: r.limit, used: r.used });
  return r;
}

/** Add `delta` to a usage counter (monthly metrics roll over by calendar month; others are gauges). */
export async function incrementUsage(db: Db | Tx, tenantId: string, metric: LimitMetric, delta = 1): Promise<void> {
  const period = MONTHLY.has(metric) ? new Date().toISOString().slice(0, 7) + "-01" : GAUGE_PERIOD;
  await inTx(db, tenantId, (tx) => tx`
    INSERT INTO usage_counters (tenant_id, metric, period, value) VALUES (${tenantId}, ${metric}, ${period}::date, ${delta})
    ON CONFLICT (tenant_id, metric, period) DO UPDATE SET value = usage_counters.value + ${delta}, updated_at = now()`);
}
