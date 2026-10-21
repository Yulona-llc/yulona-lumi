import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Keeps the Mintlify product docs (apps/docs) from rotting: navigation <-> files, frontmatter, env var coverage,
 * OpenAPI copy in sync, links resolvable. See .claude/rules/documentation.md.
 */
const root = resolve(import.meta.dir, "../..");
const docs = join(root, "apps/docs");
const cfg = JSON.parse(readFileSync(join(docs, "docs.json"), "utf8"));

function navPages(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  else if (Array.isArray(node)) node.forEach((n) => navPages(n, out));
  else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (o.pages) navPages(o.pages, out);
    for (const k of ["tabs", "groups", "anchors", "dropdowns", "versions"]) if (o[k]) navPages(o[k], out);
  }
  return out;
}
function mdx(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === "node_modules" || f.startsWith(".")) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) mdx(p, out);
    else if (f.endsWith(".mdx")) out.push(p);
  }
  return out;
}
const pages = navPages(cfg.navigation).filter((p) => !/^(GET|POST|PUT|PATCH|DELETE) /.test(p));
const files = mdx(docs);
const slug = (f: string) => relative(docs, f).replace(/\.mdx$/, "");

describe("product docs", () => {
  test("every navigation entry has a file", () => {
    const missing = pages.filter((p) => !existsSync(join(docs, `${p}.mdx`)));
    expect(missing).toEqual([]);
  });
  test("every page file is in the navigation", () => {
    const nav = new Set(pages);
    expect(files.map(slug).filter((s) => !nav.has(s))).toEqual([]);
  });
  test("every page has a title and a description, and is not a stub", () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const fm = /^---\n([\s\S]*?)\n---/.exec(src)?.[1] ?? "";
      if (!/^title:\s*\S/m.test(fm) || !/^description:\s*\S/m.test(fm)) bad.push(`${slug(f)}: frontmatter`);
      if (src.replace(/^---[\s\S]*?---/, "").trim().length < 200) bad.push(`${slug(f)}: too short (stub?)`);
      if (/\bTODO\b|\bTBD\b|lorem ipsum/i.test(src)) bad.push(`${slug(f)}: placeholder text`);
    }
    expect(bad).toEqual([]);
  });
  test("internal links point to existing pages", () => {
    const known = new Set(files.map(slug));
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?:\]\(|href=")\/((?!api-reference\/)[a-z0-9\-/]+?)(?:#[^)"]*)?(?:\)|")/g)) {
        const target = m[1]!.replace(/\/$/, "");
        if (target && !known.has(target) && !existsSync(join(docs, target))) bad.push(`${slug(f)} -> /${target}`);
      }
    }
    expect(bad).toEqual([]);
  });
  test("every variable in deploy/.env.example is documented in the configuration reference", () => {
    const env = readFileSync(join(root, "deploy/.env.example"), "utf8");
    const vars = [...env.matchAll(/^#?\s*([A-Z][A-Z0-9_]{2,})=/gm)].map((m) => m[1]!);
    const page = readFileSync(join(docs, "self-hosting/configuration.mdx"), "utf8");
    const missing = [...new Set(vars)].filter((v) => !page.includes(v));
    expect(missing).toEqual([]);
  });
  test("the API reference spec is in sync with docs/openapi.json (run `bun run docs:sync`)", () => {
    const a = readFileSync(join(root, "docs/openapi.json"), "utf8");
    const b = readFileSync(join(docs, "api-reference/openapi.json"), "utf8");
    expect(b).toBe(a);
  });
  test("changelog exists and is newest first", () => {
    const src = readFileSync(join(docs, "changelog.mdx"), "utf8");
    const dates = [...src.matchAll(/^##\s+(\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]!);
    expect(dates.length).toBeGreaterThan(0);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});
