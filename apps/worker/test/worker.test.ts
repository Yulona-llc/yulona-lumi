import { expect, test } from "bun:test";
import { join } from "node:path";

test("boots, logs, and exits 0 on SIGTERM", async () => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts")], { stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain("worker started");
  proc.kill("SIGTERM");
  expect(await proc.exited).toBe(0);
});
