import type { Db, Tx } from "./client";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertUuid(v: string, what = "id"): void {
  if (!UUID_RE.test(v)) throw new Error(`invalid ${what}`);
}

/**
 * Run `fn` in a transaction with `app.current_tenant_id` set (transaction-local), so RLS applies.
 * This is the ONLY way application code should touch tenant tables.
 */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  assertUuid(tenantId, "tenantId");
  return (await db.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`;
    return fn(tx);
  })) as T;
}

/**
 * Base class for tenant-scoped data access (layer 2). Requires a tenantId and a transaction obtained
 * from `withTenant`; subclasses must put `tenant_id = ${this.tenantId}` in every query (RLS is the
 * backstop, not a substitute).
 */
export abstract class TenantRepository {
  constructor(
    protected readonly tx: Tx,
    public readonly tenantId: string,
  ) {
    assertUuid(tenantId, "tenantId");
  }
}
