import net from "node:net";

/**
 * Optional ClamAV hook. CLAMAV_URL is either tcp://host:3310 (clamd INSTREAM) or http(s)://host:3000
 * (the benzino77/clamav-rest-api wrapper used by the compose `clamav` profile: POST /api/v1/scan,
 * multipart field FILES). Returns normally if clean or no scanner is configured; throws if infected or the
 * scanner is unreachable (fail closed when configured).
 */
export class VirusFoundError extends Error {}

async function scanHttp(bytes: Uint8Array, base: string, fetchImpl: typeof fetch): Promise<void> {
  const form = new FormData();
  form.set("FILES", new Blob([bytes as BlobPart]), "upload");
  const res = await fetchImpl(`${base.replace(/\/+$/, "")}/api/v1/scan`, { method: "POST", body: form, signal: AbortSignal.timeout(30_000) });
  // The wrapper answers 406 for an infected file; anything else non-2xx means the scanner is unusable.
  if (res.status === 406) throw new VirusFoundError("file rejected by antivirus scan");
  if (!res.ok) throw new Error(`antivirus scan failed (${res.status})`);
  const j = (await res.json().catch(() => null)) as { success?: boolean; data?: { result?: { is_infected?: boolean | null }[] } } | null;
  const results = j?.data?.result;
  if (!Array.isArray(results) || results.length === 0) throw new Error("antivirus scan failed");
  if (results.some((r) => r.is_infected === true)) throw new VirusFoundError("file rejected by antivirus scan");
  if (results.some((r) => r.is_infected !== false)) throw new Error("antivirus scan failed");
}

export async function scanUpload(bytes: Uint8Array, url = process.env.CLAMAV_URL, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!url) return;
  const u = new URL(url);
  if (u.protocol === "http:" || u.protocol === "https:") return scanHttp(bytes, url, fetchImpl);
  if (u.protocol !== "tcp:") throw new Error("antivirus scan failed (CLAMAV_URL must be tcp:// or http(s)://)");
  const host = u.hostname;
  const port = Number(u.port || 3310);
  const reply = await new Promise<string>((resolve, reject) => {
    const s = net.connect({ host, port });
    let out = "";
    s.setTimeout(20_000, () => { s.destroy(); reject(new Error("clamav timeout")); });
    s.on("error", reject);
    s.on("data", (d) => (out += d.toString()));
    s.on("end", () => resolve(out));
    s.on("connect", () => {
      s.write("zINSTREAM\0");
      const CH = 64 * 1024;
      for (let i = 0; i < bytes.length; i += CH) {
        const part = bytes.subarray(i, i + CH);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        s.write(len);
        s.write(part);
      }
      s.write(Buffer.alloc(4));
    });
  });
  if (/FOUND/.test(reply)) throw new VirusFoundError("file rejected by antivirus scan");
  if (!/OK/.test(reply)) throw new Error("antivirus scan failed");
}
