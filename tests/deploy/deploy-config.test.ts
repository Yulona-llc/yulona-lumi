import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Keeps the split deployment honest: each backend service redeploys only when something it is built from changes,
 * and each Vercel frontend skips builds that cannot affect it. See .github/workflows/deploy-backend.yml and
 * scripts/vercel-ignore.sh. No database needed.
 */
const root = resolve(import.meta.dir, "../..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

// ---- workspace graph (package name -> folder, folder -> workspace deps)
const folders = new Map<string, string>();
for (const base of ["apps", "packages"]) {
  for (const d of readdirSync(join(root, base), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    try {
      const pkg = JSON.parse(read(`${base}/${d.name}/package.json`));
      folders.set(pkg.name, `${base}/${d.name}`);
    } catch {
      /* not a workspace */
    }
  }
}
function workspaceDeps(folder: string): string[] {
  const pkg = JSON.parse(read(`${folder}/package.json`));
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((n) => folders.has(n)).map((n) => folders.get(n)!);
}
function closure(folder: string, seen = new Set<string>()): Set<string> {
  for (const dep of workspaceDeps(folder)) {
    if (!seen.has(dep)) {
      seen.add(dep);
      closure(dep, seen);
    }
  }
  return seen;
}

// ---- deploy-backend.yml filters (tiny parser for the `filters: |` block)
function backendFilters(): Record<string, string[]> {
  const lines = read(".github/workflows/deploy-backend.yml").split("\n");
  const start = lines.findIndex((l) => l.trim() === "filters: |");
  const out: Record<string, string[]> = {};
  let current = "";
  for (const line of lines.slice(start + 1)) {
    const key = line.match(/^ {12}([a-z_]+):\s*$/);
    const item = line.match(/^ {14}- "(.+)"\s*$/);
    if (key) {
      current = key[1]!;
      out[current] = [];
    } else if (item && current) out[current]!.push(item[1]!);
    else if (line.trim() && !line.startsWith(" ".repeat(12))) break;
  }
  return out;
}
const covers = (globs: string[], folder: string) => globs.includes(`${folder}/**`) || (folder.startsWith("packages/") && globs.includes("packages/**"));

describe("backend deploy paths", () => {
  const filters = backendFilters();
  const wf = read(".github/workflows/deploy-backend.yml");

  test("api image (api + worker) rebuilds for its own code and every workspace package it bundles", () => {
    const api = filters.api!;
    expect(api.length).toBeGreaterThan(0);
    for (const app of ["apps/api", "apps/worker"]) expect(covers(api, app)).toBe(true);
    for (const dep of [...closure("apps/api"), ...closure("apps/worker")]) expect(covers(api, dep)).toBe(true);
    expect(api).not.toContain("apps/admin-api/**");
    expect(api).not.toContain("deploy/rollout-admin-api.sh");
  });

  test("admin-api rebuilds for its own code and its workspace dependencies only", () => {
    const admin = filters.admin_api!;
    expect(covers(admin, "apps/admin-api")).toBe(true);
    for (const dep of closure("apps/admin-api")) expect(covers(admin, dep)).toBe(true);
    // An api/worker-only change must never redeploy the admin API.
    expect(admin).not.toContain("apps/api/**");
    expect(admin).not.toContain("apps/worker/**");
    expect(admin).not.toContain("packages/**");
    expect(admin).not.toContain("deploy/rollout.sh");
    // Packages the admin API does not depend on must not be listed.
    const needed = new Set(closure("apps/admin-api"));
    for (const g of admin) {
      const m = g.match(/^(packages\/[^/]+)\/\*\*$/);
      if (m) expect(needed.has(m[1]!)).toBe(true);
    }
  });

  test("the top-level trigger paths cover both filters", () => {
    const top = wf.split("jobs:")[0]!;
    for (const needle of ["apps/api/**", "apps/worker/**", "apps/admin-api/**", "packages/**", "deploy/rollout-admin-api.sh"]) {
      expect(top).toContain(`"${needle}"`);
    }
  });

  test("deploys are opt-in and only run on main, never on pull requests", () => {
    expect(wf).toContain("vars.BACKEND_DEPLOY_ENABLED == 'true'");
    expect(wf).toContain("branches: [main]");
    expect(wf).not.toContain("pull_request");
  });

  test("the admin-api job never starts when its image build failed or CI failed", () => {
    expect(wf).toContain("needs.image-admin-api.result == 'success'");
    expect(wf).toContain("needs: [changes, ci]");
  });

  test("the api rollout does not manage the admin-api container", () => {
    const rollout = read("deploy/rollout.sh");
    expect(rollout).not.toMatch(/up -d[^\n]*admin-api/);
    expect(rollout).toContain("unset COMPOSE_PROFILES");
    expect(read("deploy/rollout-admin-api.sh")).toContain("--project-name \"$PROJECT\"");
  });
});

describe("vercel projects", () => {
  const ignorePaths = (app: string): string[] => {
    const cfg = JSON.parse(read(`apps/${app}/vercel.json`));
    const cmd = String(cfg.ignoreCommand);
    expect(cmd).toContain("scripts/vercel-ignore.sh");
    return cmd.split(/\s+/).filter((p: string) => p.startsWith("apps/") || p.startsWith("packages/"));
  };

  test("dashboard rebuilds for itself, the widget it ships and its workspace packages", () => {
    const paths = ignorePaths("dashboard");
    expect(paths).toContain("apps/dashboard");
    expect(paths).toContain("apps/widget"); // vercel-build.sh builds and ships the widget bundle
    for (const dep of [...closure("apps/dashboard"), ...closure("apps/widget")]) expect(paths).toContain(dep);
    expect(paths).not.toContain("apps/api");
    expect(paths).not.toContain("apps/admin-api");
  });

  test("admin web rebuilds only for itself and its workspace packages", () => {
    const paths = ignorePaths("admin-web");
    expect(paths).toContain("apps/admin-web");
    for (const dep of closure("apps/admin-web")) expect(paths).toContain(dep);
    expect(paths).not.toContain("apps/dashboard");
    expect(paths).not.toContain("apps/api");
  });
});

describe("scripts/vercel-ignore.sh", () => {
  function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), "vercel-ignore-"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    cpSync(join(root, "scripts/vercel-ignore.sh"), join(dir, "scripts/vercel-ignore.sh"));
    chmodSync(join(dir, "scripts/vercel-ignore.sh"), 0o755);
    const git = (...a: string[]) => {
      const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    const commit = (file: string, text: string) => {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), text);
      git("add", "-A");
      git("commit", "-q", "-m", file);
    };
    const run = (env: Record<string, string> = {}, ...paths: string[]) =>
      spawnSync("bash", ["scripts/vercel-ignore.sh", ...paths], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH!, ...env } }).status;
    git("init", "-q", "-b", "main");
    commit("bun.lock", "lock\n");
    commit("package.json", "{}\n");
    commit("tsconfig.base.json", "{}\n");
    commit("apps/dashboard/a.ts", "1\n");
    commit("apps/api/a.ts", "1\n");
    return { dir, git, commit, run };
  }
  const paths = ["apps/dashboard", "apps/widget", "packages/shared"];

  test("skips when only another service changed, builds when its own paths changed", () => {
    const s = sandbox();
    try {
      s.commit("apps/api/b.ts", "2\n");
      expect(s.run({}, ...paths)).toBe(0); // backend-only change: skip
      s.commit("apps/dashboard/b.ts", "2\n");
      expect(s.run({}, ...paths)).toBe(1); // frontend change: build
      s.commit("packages/shared/x.ts", "x\n");
      expect(s.run({}, ...paths)).toBe(1); // shared package: build
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test("a dependency or lockfile change builds every frontend", () => {
    const s = sandbox();
    try {
      s.commit("bun.lock", "lock2\n");
      expect(s.run({}, "apps/admin-web")).toBe(1);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test("compares with the last deployed commit so earlier skipped commits are not lost", () => {
    const s = sandbox();
    try {
      const lastDeployed = s.git("rev-parse", "HEAD");
      s.commit("apps/dashboard/c.ts", "c\n"); // change that was never deployed
      s.commit("apps/api/c.ts", "c\n"); // newest commit is backend-only
      expect(s.run({}, ...paths)).toBe(0); // parent-only comparison would skip...
      expect(s.run({ VERCEL_GIT_PREVIOUS_SHA: lastDeployed }, ...paths)).toBe(1); // ...but the dashboard change must ship
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test("on Vercel, the first deployment of a branch always builds, even if the latest commit touches nothing relevant", () => {
    const s = sandbox();
    try {
      s.commit("apps/api/b.ts", "2\n"); // backend-only commit: would be skipped by a parent comparison
      expect(s.run({}, ...paths)).toBe(0);
      expect(s.run({ VERCEL: "1" }, ...paths)).toBe(1); // no VERCEL_GIT_PREVIOUS_SHA: nothing deployed yet
      expect(s.run({ VERCEL: "1", VERCEL_GIT_PREVIOUS_SHA: s.git("rev-parse", "HEAD^") }, ...paths)).toBe(0); // deployed before: normal rule
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });

  test("builds when there is nothing to compare with, or no paths are given", () => {
    const s = sandbox();
    try {
      expect(s.run({}, ...[])).toBe(1);
      const solo = mkdtempSync(join(tmpdir(), "vercel-ignore-solo-"));
      try {
        mkdirSync(join(solo, "scripts"));
        cpSync(join(root, "scripts/vercel-ignore.sh"), join(solo, "scripts/vercel-ignore.sh"));
        spawnSync("git", ["init", "-q", "-b", "main"], { cwd: solo });
        writeFileSync(join(solo, "f"), "1");
        spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: solo });
        spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x"], { cwd: solo });
        const r = spawnSync("bash", ["scripts/vercel-ignore.sh", "apps/dashboard"], { cwd: solo, encoding: "utf8" });
        expect(r.status).toBe(1);
      } finally {
        rmSync(solo, { recursive: true, force: true });
      }
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  });
});

describe("running behind your own reverse proxy", () => {
  const proxied = read("deploy/Caddyfile.proxied");
  const compose = read("deploy/docker-compose.yml");

  test("Caddyfile.proxied is plain HTTP and never trusts a forged client address", () => {
    expect(proxied).toContain("auto_https off");
    expect(proxied).toMatch(/^:80 \{/m); // no host name that could trigger a certificate request
    expect(proxied).toContain("trusted_proxies static");
    // Right-to-left parsing: without it Caddy takes the leftmost X-Forwarded-For entry, which visitors control.
    expect(proxied).toContain("trusted_proxies_strict");
    // The API trusts the rightmost entry, so Caddy must hand it exactly the real client address.
    expect(proxied).toContain("header_up X-Forwarded-For {client_ip}");
    expect(proxied).not.toContain("Strict-Transport-Security"); // TLS and HSTS belong to the outer proxy
  });

  test("the admin API example for proxy mode is plain HTTP too and passes the real client address", () => {
    const admin = read("deploy/admin-site/admin-api-proxied.caddy.example");
    expect(admin).toContain("http://{$ADMIN_SITE_ADDRESS}");
    expect(admin).toContain("header_up X-Forwarded-For {client_ip}");
  });

  test("compose lets the bind address, ports and Caddyfile be chosen, with public 80/443 as the default", () => {
    expect(compose).toContain('"${PROXY_BIND:-0.0.0.0}:${HTTP_PORT:-80}:80"');
    expect(compose).toContain('"${PROXY_BIND:-0.0.0.0}:${HTTPS_PORT:-443}:443"');
    expect(compose).toContain("./${CADDYFILE:-Caddyfile}:/etc/caddy/Caddyfile:ro");
  });

  test("setup.sh --behind-proxy writes the proxy settings and no 80/443 mapping", () => {
    const setup = read("deploy/setup.sh");
    for (const needle of ["--behind-proxy)", "CADDYFILE=Caddyfile.proxied", 'PROXY_BIND=$proxy_bind', 'HTTP_PORT=$proxy_port']) {
      expect(setup).toContain(needle);
    }
  });

  test("the workflow copies the Caddy files in place so the bind mounts keep working", () => {
    const wf = read(".github/workflows/deploy-backend.yml");
    expect(wf).toContain('cat deploy/Caddyfile.proxied > "$YULONA_ROOT/deploy/Caddyfile.proxied"');
    expect(wf).not.toMatch(/install[^\n]*Caddyfile/);
  });
});

describe("redis restarts", () => {
  test("redis starts as its own user, not through the root entrypoint that fails once capabilities are dropped", () => {
    const compose = read("deploy/docker-compose.yml");
    const redis = compose.slice(compose.indexOf("\n  redis:\n"), compose.indexOf("\nnetworks:"));
    expect(redis).toContain("user: redis");
    // The root entrypoint needs CHOWN/SETUID/SETGID plus DAC_OVERRIDE to survive a second start; running as redis needs none.
    expect(redis).not.toMatch(/cap_add/);
  });
});
