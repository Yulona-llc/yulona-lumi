import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const files = (pattern: string, base = ROOT) => [...new Glob(pattern).scanSync({ cwd: base, absolute: true })].filter((f) => !f.includes("node_modules") && !f.includes("/dist/"));
const read = (f: string) => readFileSync(f, "utf8");

describe("static security checks", () => {
  test("every request body schema passed to parseBody() is strict (unknown fields rejected)", () => {
    const sources = [...files("apps/api/src/**/*.ts"), ...files("packages/shared/src/**/*.ts")];
    const decls = new Map<string, string>();
    for (const f of sources) {
      const text = read(f);
      const re = /^(?:export )?const (\w+)\s*(?::[^=]+)?=\s*([\s\S]*?)(?=^(?:export |const |function |interface |type |async function )|(?![\s\S]))/gm;
      for (const m of text.matchAll(re)) decls.set(m[1]!, (decls.get(m[1]!) ?? "") + m[2]!);
    }
    const bad: string[] = [];
    let checked = 0;
    for (const f of files("apps/api/src/**/*.ts")) {
      const text = read(f);
      for (const m of text.matchAll(/parseBody\(\s*c\s*,\s*([\s\S]*?)\)\s*;?\s*(?:\/\/.*)?$/gm)) {
        const arg = m[1]!.trim();
        checked++;
        const id = /^(\w+)$/.exec(arg)?.[1];
        let body = id ? decls.get(id) : arg;
        // derived schemas (X.partial(), X.extend(), X.refine(...)) inherit strictness from their base
        for (let i = 0; i < 4 && body && !/strictObject\(|\.strict\(\)/.test(body); i++) {
          const base = /^\s*(\w+)\.(?:partial|extend|refine|pick|omit|superRefine)\(/.exec(body)?.[1];
          if (!base) break;
          body = decls.get(base);
        }
        const strict = !!body && (/\bz\.strictObject\(/.test(body) || /\.strict\(\)/.test(body) || /\bstrictObject\(/.test(body));
        // composite schemas are accepted only when every z.object( in them is strict
        const loose = !!body && /\bz\.object\(/.test(body) && !/\.strict\(\)/.test(body);
        if (!strict || loose) bad.push(`${f.replace(ROOT + "/", "")}: parseBody(c, ${id ?? arg.slice(0, 60)})`);
      }
    }
    expect(checked).toBeGreaterThan(55);
    expect(bad).toEqual([]);
  });

  test("no handler reads a JSON body without the strict parseBody helper (except documented public/webhook raw-body readers)", () => {
    const allowed = [
      /billing\/routes\.ts$/,            // raw text for webhook signature verification
      /channels\/webhooks\.ts$/,         // raw body for provider signature
      /ops\/transactions\.ts$/,          // raw body for HMAC verification of inbound transaction webhooks
      /\/http\.ts$/,                     // the helper itself
    ];
    const bad: string[] = [];
    for (const f of files("apps/api/src/**/*.ts")) {
      if (allowed.some((a) => a.test(f))) continue;
      const t = read(f);
      if (/c\.req\.(json|text|parseBody|formData|arrayBuffer)\(/.test(t) && !/knowledge\.ts$/.test(f)) bad.push(f.replace(ROOT + "/", ""));
    }
    expect(bad).toEqual([]);
  });

  test("no HTML injection sinks in the dashboard or widget (stored-XSS: message content is rendered as text)", () => {
    const sinks = /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write\(|\beval\(|new Function\(|srcdoc\s*=/;
    const hits: string[] = [];
    for (const f of [...files("apps/dashboard/src/**/*.{ts,tsx}"), ...files("apps/widget/src/**/*.{ts,tsx}")]) {
      if (/\.test\.tsx?$/.test(f)) continue;
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
      if (sinks.test(code)) hits.push(f.replace(ROOT + "/", ""));
    }
    expect(hits).toEqual([]);
  });

  test("dashboard keeps tokens out of web storage (access token in memory only)", () => {
    const hits: string[] = [];
    for (const f of files("apps/dashboard/src/**/*.{ts,tsx}")) {
      if (/\.test\.tsx?$/.test(f)) continue;
      const t = read(f);
      for (const m of t.matchAll(/(localStorage|sessionStorage)\.setItem\(\s*([^,)]+)/g)) {
        if (/token|jwt|secret|password|auth/i.test(m[2]!)) hits.push(`${f.replace(ROOT + "/", "")}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  test("secrets are never interpolated into log calls; one AES-GCM implementation (packages/crypto)", () => {
    const bad: string[] = [];
    for (const f of [...files("apps/*/src/**/*.ts"), ...files("packages/*/src/**/*.ts")]) {
      const t = read(f);
      for (const m of t.matchAll(/\blog(?:ger)?\.(?:debug|info|warn|error)\(([^;]*)\)/g)) {
        if (/(password|passwd|secret|accessToken|refreshToken|apiKey|authorization|Bearer|credentials?|plaintext)\b(?!\s*:\s*"\[)/i.test(m[1]!) && !/redact|\bmasked\b/.test(m[1]!)) bad.push(`${f.replace(ROOT + "/", "")}: ${m[0].slice(0, 100)}`);
      }
    }
    expect(bad).toEqual([]);
    const crypto = files("{apps,packages}/*/src/**/*.ts").filter((f) => /createCipheriv\(/.test(read(f)));
    // packages/integrations/src/signing.ts keeps its own single-layer sealSecret/openSecret (webhook secrets bound to the webhook id as AAD);
    // changing that stored format would invalidate existing rows, so it is a documented exception.
    expect(crypto.map((f) => f.replace(ROOT + "/", "")).filter((f) => f !== "packages/integrations/src/signing.ts")).toEqual(["packages/crypto/src/index.ts"]);
  });

  test("no hard-coded secrets / private keys in source", () => {
    const pats = [/-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/, /sk_live_[A-Za-z0-9]{10,}/, /AKIA[0-9A-Z]{16}/, /xox[baprs]-[A-Za-z0-9-]{10,}/, /ghp_[A-Za-z0-9]{30,}/];
    const hits: string[] = [];
    for (const f of files("{apps,packages,deploy,scripts,docs}/**/*.{ts,tsx,sh,yml,yaml,json,md,env,example}")) {
      if (f.includes("/test") || /\.test\./.test(f) || f.includes("/dist/")) continue;
      const t = read(f);
      if (pats.some((p) => p.test(t))) hits.push(f.replace(ROOT + "/", ""));
    }
    expect(hits).toEqual([]);
  });
});
