import { createLlmResolver, portsFromResolver, type AiPorts } from "@yulona/ai-runtime";
import type { Db } from "@yulona/db";
import type { Config } from "../config";

/** Lazily built LLM ports (platform provider profile in SaaS, env otherwise); tests inject their own. */
export function lazyPorts(cfg: Config, db: Db, injected?: AiPorts): () => AiPorts {
  let resolved: AiPorts | undefined;
  return () => injected ?? (resolved ??= portsFromResolver(createLlmResolver({ db, mode: cfg.deploymentMode, encryptionKey: cfg.encryptionKey })));
}
