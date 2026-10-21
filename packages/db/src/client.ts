import postgres from "postgres";

export type Db = postgres.Sql;
export type Tx = postgres.TransactionSql;

export interface DbOptions {
  max?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
}

/**
 * Pooled connection with sane limits. Use the app role URL (yulona_app) here, never the owner.
 * Rows come back camelCased.
 */
export function createDb(url: string, opts: DbOptions = {}): Db {
  return postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    max_lifetime: 60 * 30,
    onnotice: () => {},
    transform: { column: { from: postgres.toCamel } },
    connection: {
      application_name: opts.applicationName ?? "yulona",
      statement_timeout: opts.statementTimeoutMs ?? 15_000,
      idle_in_transaction_session_timeout: 15_000,
      lock_timeout: 5_000,
    },
  });
}

export async function closeDb(db: Db, timeoutSeconds = 10): Promise<void> {
  await db.end({ timeout: timeoutSeconds });
}
