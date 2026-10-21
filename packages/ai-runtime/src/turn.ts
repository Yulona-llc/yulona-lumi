import type { ChannelCapability, ConversionStage, WidgetUIComponent } from "@yulona/shared";
import { contactFormBlock, formatForChannel, isWindowExpired, messageBlock } from "./format";
import type { AiPorts, ChatMessage } from "./ports";
import { buildSystemPrompt, escapeData, wrapUserMessage } from "./prompt";
import type { KnowledgePort, SkillSection, SkillSummary } from "./knowledge";
import { wantsHuman } from "./intent";
import { isSmallTalk } from "./smalltalk";
import { shortestPath } from "./stage";
import { executeTool, resolveTools, toolSpecsForStage, type ExternalToolProvider, type ToolEffects } from "./tools";
import type { Resolver } from "./ssrf";
import type { ConnectionResolver } from "./http-tool";
import type { AgentConfig, HandoffRecord, HandoffType, Lead, LeadCard, RetrievedChunk, ToolRun, TurnMessage, TurnResult } from "./types";

export interface TurnInput {
  agent: AgentConfig;
  capability: ChannelCapability;
  stage: ConversionStage;
  lead: Lead;
  history: TurnMessage[];
  userText: string;
  /** structured submission from the widget (form) routed by the conversations API */
  uiEvent?: { type: "form"; values: Record<string, unknown> };
  /** this agent's skills (knowledge); supplied by the caller, each call runs its own short tenant transaction */
  knowledge: KnowledgePort;
  dryRun?: boolean;
  external?: ExternalToolProvider;
  conversationId?: string | null;
  lastCustomerMessageAt?: Date | null;
  /** consecutive ungrounded questions so far in this conversation */
  unansweredTurns?: number;
  /** appended to any handoff message (offline notice + how to resume with the AI); built by the runtime */
  handoffNotice?: string;
  /** SaaS credit gate tripped: skip the model, raise a system_failure handoff (reason ai_credits_exhausted) with this customer notice */
  creditsExhausted?: { message: string };
  resolver?: Resolver;
  fetchImpl?: typeof fetch;
  /** resolves tool connections for manifest-v2 tools (server-side only) */
  connections?: ConnectionResolver;
}

export interface TurnOutcome extends TurnResult {
  /** stages to walk through, in order, starting from stageBefore (empty = unchanged) */
  stagePlan: ConversionStage[];
  leadPatch: Lead;
}

const MAX_TOOL_ROUNDS = 4;
/** Whole knowledge base at most this many characters => put it all in the prompt (no tools, one LLM call). */
const INLINE_ALL_CHARS = 9000;
const PRELOAD_SECTIONS = 4;
const READ_CAP_CHARS = 8000;

export const KNOWLEDGE_TOOLS = ["search_skills", "read_skill"] as const;
const knowledgeToolSpecs = () => [
  {
    name: "search_skills",
    description: "Keyword search across your skills. Use short, specific keywords (try synonyms and singular/plural). Returns matching sections with a snippet; open a section with read_skill.",
    parameters: { type: "object", additionalProperties: false, properties: { query: { type: "string", description: "keywords" }, skill: { type: "string", description: "optional skill id to search inside" } }, required: ["query"] },
  },
  {
    name: "read_skill",
    description: "Open a skill. With `section` it returns that section's full text; without it, the whole skill if short, otherwise its outline of numbered sections.",
    parameters: { type: "object", additionalProperties: false, properties: { skill: { type: "string", description: "skill id from the skill list" }, section: { type: "integer", minimum: 0, description: "section number" } }, required: ["skill"] },
  },
];

const toChunk = (s: SkillSection): RetrievedChunk => ({ id: `${s.skill}#${s.section}`, sourceId: s.sourceId, sourceName: `${s.skillName} › ${s.title}`, content: s.content, score: s.score });
export const NO_ANSWER = "[[NO_ANSWER]]";

export function buildLeadCard(stage: ConversionStage, lead: Lead, history: TurnMessage[], userText: string): LeadCard {
  return { ...lead, stage, summary: summarize(history, userText) };
}

export function summarize(history: TurnMessage[], userText: string): string {
  const lines = [...history.slice(-6), { role: "user" as const, content: userText }].map((m) => `${m.role === "user" ? "Customer" : "AI"}: ${m.content.replace(/\s+/g, " ").slice(0, 200)}`);
  return lines.join("\n").slice(0, 1200);
}

function makeHandoff(a: { type: HandoffType; reason: string; input: TurnInput; stage: ConversionStage; lead: Lead; message?: string }): HandoffRecord {
  const hasLead = Object.values(a.lead).some((v) => v !== undefined && v !== "");
  return {
    type: a.type,
    reason: a.reason,
    summary: summarize(a.input.history, a.input.userText),
    leadCard: a.type === "stage" || hasLead ? buildLeadCard(a.stage, a.lead, a.input.history, a.input.userText) : undefined,
    customerMessage: [a.message ?? (a.type === "uncertainty" ? a.input.agent.fallbackMessage : a.input.agent.handoffMessage), a.input.handoffNotice].filter(Boolean).join(" "),
  };
}

const isQualified = (l: Lead) => !!l.need && !!(l.budget || l.timeline);

/**
 * One AI turn, without persistence: retrieve -> guard -> prompt -> LLM/tools -> format.
 * Pure with respect to the database so the sandbox endpoint and the real runtime share it.
 */
export async function runTurn(ports: AiPorts, input: TurnInput): Promise<TurnOutcome> {
  const { agent, capability } = input;
  const usage = { promptTokens: 0, completionTokens: 0 };
  let llmMeta: { model?: string; profileId?: string | null; modelFallback?: { requested: string; used: string } } = {};
  const toolRuns: ToolRun[] = [];
  let lead: Lead = { ...input.lead };
  let leadPatch: Lead = {};
  let retrieved: RetrievedChunk[] = [];
  const tools = resolveTools(agent, input.external);
  const execCtx = () => ({ stage: input.stage, lead, dryRun: input.dryRun, external: input.external, tenantId: agent.tenantId, conversationId: input.conversationId ?? null, resolver: input.resolver, fetchImpl: input.fetchImpl, connections: input.connections });

  const applyEffects = (e: ToolEffects) => {
    if (e.leadPatch) {
      const clean = Object.fromEntries(Object.entries(e.leadPatch).filter(([, v]) => v !== undefined && v !== ""));
      lead = { ...lead, ...clean };
      leadPatch = { ...leadPatch, ...clean };
    }
  };

  const finish = (o: { components: WidgetUIComponent[]; handoff?: HandoffRecord; guard?: boolean; advance?: boolean; unanswered?: number }): TurnOutcome => {
    let stagePlan: ConversionStage[] = [];
    if (o.handoff?.alreadyRaised) {
      stagePlan = []; // the external tool already moved the conversation to handoff_requested
    } else if (o.handoff) {
      stagePlan = shortestPath(input.stage, "handoff_requested") ?? [];
    } else if (o.advance) {
      let target: ConversionStage = input.stage === "visitor" ? "engaged" : input.stage;
      if ((input.stage === "visitor" || input.stage === "engaged") && isQualified(lead)) target = "qualified";
      stagePlan = shortestPath(input.stage, target) ?? [];
    }
    let handoff = o.handoff;
    if (!handoff && agent.handoffAtQualified && stagePlan.includes("qualified")) {
      handoff = makeHandoff({ type: "stage", reason: "lead qualified", input, stage: "qualified", lead });
      stagePlan = [...stagePlan, "handoff_requested"];
    }
    const comps = handoff ? [messageBlock(handoff.customerMessage)] : o.components;
    const { ui, text } = formatForChannel(comps, capability);
    return {
      ui, text, stageBefore: input.stage, stageAfter: handoff?.alreadyRaised ? "handoff_requested" : (stagePlan[stagePlan.length - 1] ?? input.stage),
      retrieved, guardTriggered: !!o.guard, unansweredAfter: o.unanswered ?? input.unansweredTurns ?? 0, handoff, toolRuns, lead, leadPatch, stagePlan, usage, ...llmMeta,
      windowExpired: isWindowExpired(capability, input.lastCustomerMessageAt ?? null) || undefined,
    };
  };

  if (input.creditsExhausted) {
    return finish({ components: [], handoff: makeHandoff({ type: "system_failure", reason: "ai_credits_exhausted", input, stage: input.stage, lead, message: input.creditsExhausted.message }) });
  }

  // ---- structured widget submissions bypass the LLM (deterministic, no hallucination surface)
  if (input.uiEvent?.type === "form") {
    const v = input.uiEvent.values;
    const contact: Record<string, unknown> = {};
    for (const k of ["name", "email", "phone"]) if (typeof v[k] === "string" && v[k]) contact[k] = v[k];
    const qual: Record<string, unknown> = {};
    for (const k of ["need", "budget", "timeline"]) if (typeof v[k] === "string" && v[k]) qual[k] = v[k];
    const calls = [
      ...(Object.keys(contact).length ? [{ name: "collect_contact", arguments: contact }] : []),
      ...(qual.need ? [{ name: "qualify_lead", arguments: qual }] : []),
    ];
    for (const c of calls) {
      const ex = await executeTool(tools, c, execCtx());
      toolRuns.push(ex.run);
      if (ex.kind === "failed") return finish({ components: [], handoff: makeHandoff({ type: "system_failure", reason: `tool ${c.name} failed: ${ex.run.error}`, input, stage: input.stage, lead }) });
      if (ex.kind === "ok") applyEffects(ex.effects);
    }
    const ok = toolRuns.some((r) => r.success);
    return finish({ components: [messageBlock(ok ? "Thanks, I've saved your details. How else can I help?" : "Sorry, I couldn't use those details. Could you check them and try again?")], advance: true });
  }

  // ---- retrieval + hallucination guard
  // The customer explicitly asked for a person (or hit one of the operator's escalation keywords): hand off now.
  const lowered = input.userText.toLowerCase();
  const askedForPerson = wantsHuman(input.userText) || agent.escalationKeywords.some((k) => lowered.includes(k));
  if (askedForPerson) {
    return finish({
      components: [], guard: false,
      handoff: makeHandoff({ type: "uncertainty", reason: "customer asked for a person", input, stage: input.stage, lead, message: agent.handoffMessage }),
    });
  }

  // Pleasantries need no knowledge: answer conversationally, no tools.
  const smallTalk = isSmallTalk(input.userText);
  let skills: SkillSummary[] = [];
  let toolsMode = false;
  if (!smallTalk) {
    skills = await input.knowledge.index();
    const total = skills.reduce((a, s) => a + s.chars, 0);
    if (skills.length && total <= INLINE_ALL_CHARS) {
      retrieved = (await input.knowledge.all(INLINE_ALL_CHARS)).map(toChunk); // tiny knowledge base: everything is in the prompt
    } else if (skills.length) {
      toolsMode = true;
      const lastUser = [...input.history].reverse().find((m) => m.role === "user")?.content ?? "";
      let found = await input.knowledge.search(input.userText, { limit: PRELOAD_SECTIONS });
      if (found.length < 2 && lastUser) found = [...found, ...(await input.knowledge.search(`${lastUser} ${input.userText}`, { limit: PRELOAD_SECTIONS }))].slice(0, PRELOAD_SECTIONS);
      retrieved = [...new Map(found.map((f) => [`${f.skill}#${f.section}`, f])).values()].map(toChunk);
    }
  }
  // No grounded answer. Ask for clarification first; hand off only after `maxUnansweredTurns` misses in a row.
  let clarify = false;
  let unanswered: number | undefined;
  /** Count one more ungrounded turn; returns the handoff outcome when the agent's limit is reached. */
  const miss = (reason: string): TurnOutcome | null => {
    unanswered = (input.unansweredTurns ?? 0) + 1;
    if (unanswered < agent.maxUnansweredTurns) return null;
    return finish({ components: [], guard: true, unanswered, handoff: makeHandoff({ type: "uncertainty", reason, input, stage: input.stage, lead }) });
  };
  if (!smallTalk && skills.length === 0) {
    const handoff = miss("the agent has no knowledge to answer from");
    if (handoff) return handoff;
    clarify = true;
  } else if (!smallTalk) {
    unanswered = 0;
  }

  // ---- LLM loop
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt({ agent, stage: input.stage, lead, chunks: retrieved, capability, smallTalk, clarify, skills: toolsMode ? skills : undefined, customToolNames: [...tools.values()].filter((t) => t.custom).map((t) => t.manifest.name) }) },
    ...input.history.map((m): ChatMessage => (m.role === "user" ? { role: "user", content: wrapUserMessage(m.content) } : { role: "assistant", content: m.content })),
    { role: "user", content: wrapUserMessage(input.userText) },
  ];
  const specs = smallTalk || clarify ? [] : [...toolSpecsForStage(tools, input.stage), ...(toolsMode ? knowledgeToolSpecs() : [])];
  let ask: Set<"name" | "email" | "phone"> = new Set();
  let finalText = "";

  /** Executes search_skills / read_skill; results go back to the model and into `retrieved` (shown in the sandbox). */
  const runKnowledgeTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const started = Date.now();
    const remember = (secs: SkillSection[]) => {
      for (const sec of secs) if (!retrieved.some((r) => r.id === `${sec.skill}#${sec.section}`)) retrieved.push(toChunk(sec));
    };
    let text: string;
    let ok = true;
    try {
      if (name === "search_skills") {
        const query = String(args.query ?? "").slice(0, 200);
        const hits = query.trim() ? await input.knowledge.search(query, { skill: typeof args.skill === "string" ? args.skill : undefined, limit: 6 }) : [];
        remember(hits);
        text = hits.length
          ? hits.map((h) => `[${h.skill}#${h.section}] ${h.skillName} › ${h.title}\n${h.content.replace(/\s+/g, " ").slice(0, 240)}`).join("\n\n")
          : "No sections matched. Try other keywords (synonyms, singular/plural) or open a skill from the list with read_skill.";
      } else {
        const sec = Number.isInteger(args.section) ? (args.section as number) : undefined;
        const r = await input.knowledge.read(String(args.skill ?? ""), sec);
        if (!r) text = "Unknown skill. Use an id from the skill list.";
        else if (r.outline) text = `Skill ${r.skill.slug} is long. Outline (open one with read_skill {skill, section}):\n${r.outline.map((o) => `${o.section}. ${o.title} (${o.chars} chars)`).join("\n")}`;
        else if (!r.sections.length) text = "No such section.";
        else {
          remember(r.sections);
          text = r.sections.map((x) => `# ${x.skillName} › ${x.title}\n${x.content}`).join("\n\n").slice(0, READ_CAP_CHARS);
        }
      }
    } catch (e) {
      ok = false;
      text = "Knowledge lookup failed; answer only from what you already have.";
      toolRuns.push({ name, input: args, success: false, error: (e as Error).message.slice(0, 200), latencyMs: Date.now() - started });
      return text;
    }
    toolRuns.push({ name, input: args, output: { chars: text.length }, success: ok, latencyMs: Date.now() - started });
    return `<knowledge_result>\n${escapeData(text)}\n</knowledge_result>`;
  };

  const callLlm = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await ports.llm.chat({ model: agent.model, messages, tools: specs.length ? specs : undefined, temperature: 0.2, maxTokens: 700 });
      } catch (e) {
        if (attempt >= 1) throw e;
      }
    }
  };

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    let res;
    try {
      res = await callLlm();
    } catch (e) {
      return finish({ components: [], handoff: makeHandoff({ type: "system_failure", reason: `LLM unavailable: ${(e as Error).message.slice(0, 200)}`, input, stage: input.stage, lead }) });
    }
    usage.promptTokens += res.usage.promptTokens;
    usage.completionTokens += res.usage.completionTokens;
    llmMeta = { model: res.model ?? llmMeta.model, profileId: res.profileId ?? llmMeta.profileId, modelFallback: res.modelFallback ?? llmMeta.modelFallback };
    if (!res.toolCalls.length || round === MAX_TOOL_ROUNDS) {
      finalText = (res.content ?? "").trim();
      break;
    }
    messages.push({ role: "assistant", content: res.content ?? "", toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      if (toolsMode && (call.name === "search_skills" || call.name === "read_skill")) {
        const out = await runKnowledgeTool(call.name, call.arguments);
        messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: out });
        continue;
      }
      const ex = await executeTool(tools, call, execCtx());
      toolRuns.push(ex.run);
      if (ex.kind === "failed") {
        const h = makeHandoff({ type: "system_failure", reason: `tool ${call.name} failed: ${ex.run.error}`, input, stage: input.stage, lead });
        return finish({ components: [], handoff: ex.handoffRaised ? { ...h, alreadyRaised: true } : h });
      }
      if (ex.kind === "ok") {
        applyEffects(ex.effects);
        ex.effects.ask?.forEach((f) => ask.add(f));
        if (ex.effects.escalate) {
          return finish({ components: [], handoff: makeHandoff({ ...ex.effects.escalate, input, stage: input.stage, lead }) });
        }
      }
      messages.push({ role: "tool", toolCallId: call.id, name: call.name, content: ex.modelResult });
    }
  }

  // The model judged that the excerpts do not contain the answer: same path as a retrieval miss.
  if (finalText.includes(NO_ANSWER)) {
    if (!clarify && !smallTalk) {
      const handoff = miss("the model could not answer from its knowledge");
      if (handoff) return handoff;
      clarify = true;
    }
    finalText = finalText.split(NO_ANSWER).join(" ").replace(/\s+/g, " ").trim();
  }
  if (clarify && !finalText) finalText = agent.clarifyMessage;
  if (smallTalk && !finalText) finalText = `Hi! I'm ${agent.name}. How can I help you today?`;
  if (!finalText && ask.size === 0) {
    return finish({ components: [], guard: true, handoff: makeHandoff({ type: "uncertainty", reason: "model produced no answer", input, stage: input.stage, lead }) });
  }
  const comps: WidgetUIComponent[] = [];
  if (finalText) comps.push(messageBlock(finalText));
  const missing = [...ask].filter((f) => !lead[f]);
  if (missing.length) {
    if (!finalText) comps.push(messageBlock("Could you share your contact details?"));
    comps.push(contactFormBlock(missing));
  }
  return finish({ components: comps, advance: !clarify, guard: clarify, unanswered });
}
