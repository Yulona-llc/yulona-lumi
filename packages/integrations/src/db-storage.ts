import { withTenant, type Db } from "@yulona/db";
import type { StorageProvider, StoredObject } from "@yulona/providers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<area>/<tenant id>/<file>`: the tenant is part of every key (see exportKey), which keeps each access inside that tenant's RLS. */
function tenantOf(key: string): string {
  const t = key.split("/")[1];
  if (!t || !UUID.test(t)) throw new Error(`storage key must look like <area>/<tenant id>/<file>: ${key}`);
  return t;
}

/**
 * Object storage in Postgres, for installs without an S3/MinIO bucket. The API and the worker are separate processes, so the
 * in-memory fallback cannot hand a file from one to the other; the database can. Meant for small files (export archives);
 * set S3_BUCKET for anything big.
 */
export class DbStorageProvider implements StorageProvider {
  readonly name = "database";
  constructor(private readonly db: Db) {}

  async put(key: string, body: Uint8Array | string, opts?: { contentType?: string }): Promise<void> {
    const tenantId = tenantOf(key);
    const data = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
    await withTenant(this.db, tenantId, (tx) => tx`
      INSERT INTO object_store (tenant_id, key, content_type, data) VALUES (${tenantId}, ${key}, ${opts?.contentType ?? null}, ${data})
      ON CONFLICT (tenant_id, key) DO UPDATE SET content_type = EXCLUDED.content_type, data = EXCLUDED.data, created_at = now()`);
  }
  async get(key: string): Promise<StoredObject | null> {
    const tenantId = tenantOf(key);
    const [r] = await withTenant(this.db, tenantId, (tx) => tx<{ data: Buffer; contentType: string | null }[]>`
      SELECT data, content_type FROM object_store WHERE tenant_id = ${tenantId} AND key = ${key}`);
    return r ? { body: new Uint8Array(r.data), contentType: r.contentType ?? undefined } : null;
  }
  async delete(key: string): Promise<void> {
    const tenantId = tenantOf(key);
    await withTenant(this.db, tenantId, (tx) => tx`DELETE FROM object_store WHERE tenant_id = ${tenantId} AND key = ${key}`);
  }
  async exists(key: string): Promise<boolean> {
    const tenantId = tenantOf(key);
    return (await withTenant(this.db, tenantId, (tx) => tx`SELECT 1 FROM object_store WHERE tenant_id = ${tenantId} AND key = ${key}`)).length > 0;
  }
  /** No presigned links: the API streams the file itself (still authenticated). */
  async signedUrl(): Promise<string | null> {
    return null;
  }
}

/** The configured storage, or the database when none is (the in-memory default cannot be shared between the API and the worker). */
export function storageOrDatabase(configured: StorageProvider, db: Db): StorageProvider {
  return configured.name === "memory" ? new DbStorageProvider(db) : configured;
}
