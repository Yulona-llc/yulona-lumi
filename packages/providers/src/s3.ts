import type { StorageProvider, StoredObject, VirusScanner } from "./types";

export interface S3Options {
  endpoint?: string;
  bucket: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** S3-compatible storage (AWS S3, MinIO) via Bun's built-in S3 client. */
export class S3StorageProvider implements StorageProvider {
  readonly name = "s3";
  private readonly client: Bun.S3Client;
  constructor(o: S3Options) {
    this.client = new Bun.S3Client({
      endpoint: o.endpoint, bucket: o.bucket, region: o.region ?? "us-east-1",
      accessKeyId: o.accessKeyId, secretAccessKey: o.secretAccessKey,
    });
  }
  async put(key: string, body: Uint8Array | string, opts?: { contentType?: string }) {
    await this.client.write(key, body, { type: opts?.contentType });
  }
  async get(key: string): Promise<StoredObject | null> {
    const f = this.client.file(key);
    if (!(await f.exists())) return null;
    return { body: new Uint8Array(await f.arrayBuffer()), contentType: f.type || undefined };
  }
  async delete(key: string) {
    await this.client.delete(key);
  }
  async exists(key: string) {
    return this.client.exists(key);
  }
  async signedUrl(key: string, opts?: { expiresInSec?: number }) {
    return this.client.presign(key, { expiresIn: opts?.expiresInSec ?? 900, method: "GET" });
  }
}

/** ClamAV via a clamav-rest style HTTP endpoint (POST /scan, multipart `file`). Fails closed. */
export class ClamAvHttpScanner implements VirusScanner {
  constructor(private readonly url: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async scan(body: Uint8Array) {
    const form = new FormData();
    form.set("file", new Blob([body as BlobPart]), "upload");
    const res = await this.fetchImpl(`${this.url.replace(/\/+$/, "")}/scan`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`virus scanner unavailable (${res.status})`);
    const j = (await res.json()) as { infected?: boolean; signature?: string; status?: string };
    const infected = j.infected ?? j.status === "FOUND";
    return infected ? { clean: false, signature: j.signature } : { clean: true };
  }
}
