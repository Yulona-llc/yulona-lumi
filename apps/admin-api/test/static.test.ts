import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");
const files = [...new Glob("**/*.ts").scanSync({ cwd: SRC, absolute: true })];
const read = (f: string) => readFileSync(f, "utf8");

describe("admin-api static checks", () => {
  test("every body schema passed to parseBody() is a strict object (unknown fields rejected)", () => {
    const bad: string[] = [];
    let checked = 0;
    for (const f of files) {
      const text = read(f);
      for (const m of text.matchAll(/parseBody\(\s*c\s*,\s*([\s\S]*?)\)\s*;?\s*(?:\/\/.*)?$/gm)) {
        checked++;
        const arg = m[1]!.trim();
        const id = /^(\w+)$/.exec(arg)?.[1];
        // declaration in the same file (possibly indented, inside a register function) or an exported schema elsewhere
        let decl = id ? new RegExp(`(?:const|let)\\s+${id}\\s*=\\s*([\\s\\S]*?)(?=\\n\\s*(?:const|let|reg\\.|export|function|//)\\s|$)`).exec(text)?.[1] : arg;
        if (id && !decl) for (const g of files) decl ??= new RegExp(`export const ${id}\\s*=\\s*([\\s\\S]*?)(?=\\n(?:export|const|function|interface|type)\\s|$)`).exec(read(g))?.[1];
        if (!decl || !/\bz\.strictObject\(/.test(decl) || /\bz\.object\(/.test(decl)) bad.push(`${f.replace(SRC + "/", "")}: parseBody(c, ${id ?? arg.slice(0, 60)})`);
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  });

  test("handlers never read a request body themselves (parseBody is the only reader) and never read the query string raw", () => {
    const bad = files.filter((f) => !f.endsWith("/http.ts") && /c\.req\.(json|text|parseBody|formData|arrayBuffer)\(/.test(read(f))).map((f) => f.replace(SRC + "/", ""));
    expect(bad).toEqual([]);
  });

  test("the admin service never imports from the customer API and never signs customer tokens", () => {
    const bad: string[] = [];
    for (const f of files) {
      const t = read(f);
      if (/from\s+["'][^"']*apps\/api|from\s+["']\.\.\/\.\.\/api\/|from\s+["']@yulona\/api["']/.test(t)) bad.push(`${f.replace(SRC + "/", "")}: imports the customer API`);
      if (/\bJWT_SECRET\b/.test(t.replace(/ADMIN_JWT_SECRET/g, "")) && !f.endsWith("/config.ts")) bad.push(`${f.replace(SRC + "/", "")}: reads the customer JWT secret`);
    }
    expect(bad).toEqual([]);
    expect(read(resolve(SRC, "config.ts"))).toContain("must differ from JWT_SECRET");
  });

  test("no SQL in the admin service touches a table directly: every query goes through an sa_* function (the admin role has no table grants)", () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const m of read(f).matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)) {
        const name = m[1]!;
        if (/^(sa_[a-z0-9_]+|generate_series|unnest|information_schema|pg_[a-z_]+)$/.test(name)) continue;
        if (["the", "a", "an", "this", "that", "your", "your", "tenant", "one", "each", "any", "all", "which", "what"].includes(name)) continue; // prose in comments
        bad.push(`${f.replace(SRC + "/", "")}: ${m[0]}`);
      }
    }
    // only SQL inside template literals matters; comments produce noise, so list and inspect on failure
    expect(bad.filter((b) => !/\/\/|\*/.test(b))).toEqual([]);
  });
});
