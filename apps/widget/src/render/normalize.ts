/**
 * Defensive, dependency-free normalisation of WidgetUISchema payloads.
 * We deliberately do NOT import zod at runtime (bundle size); the server already validates.
 * Anything we do not understand degrades to its text (if any) or is dropped. Never throws.
 */
export const SUPPORTED_VERSION = 1;

export interface Action { label: string; value: string }
export type Field = {
  name: string;
  label: string;
  kind: "text" | "email" | "phone" | "textarea" | "select";
  required: boolean;
  options: string[];
};
export type Block =
  | { type: "message"; key: string; text: string }
  | { type: "buttons"; key: string; buttons: Action[] }
  | { type: "card"; key: string; title: string; body?: string; imageUrl?: string; actions: Action[] }
  | { type: "form"; key: string; submitLabel: string; fields: Field[] }
  | { type: "calendar"; key: string; timezone: string; slots: { start: string; end: string }[] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 4000) => (typeof v === "string" ? v.slice(0, max) : undefined);
const actions = (v: unknown, max: number): Action[] =>
  (Array.isArray(v) ? v : [])
    .slice(0, max)
    .flatMap((a) => (isObj(a) && str(a.label) && typeof a.value === "string" ? [{ label: str(a.label, 80)!, value: a.value.slice(0, 200) }] : []));

const FIELD_KINDS = new Set(["text", "email", "phone", "textarea", "select"]);

export function safeUrl(u: unknown, protocols = ["https:", "http:"]): string | undefined {
  if (typeof u !== "string") return undefined;
  try {
    const url = new URL(u.trim());
    return protocols.includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function normalize(ui: unknown, fallbackText: string | undefined, idPrefix: string): Block[] {
  const out: Block[] = [];
  const comps = isObj(ui) && Array.isArray(ui.components) ? ui.components : [];
  comps.slice(0, 20).forEach((c, i) => {
    if (!isObj(c)) return;
    const key = `${idPrefix}:${str(c.id, 64) ?? i}`;
    switch (c.type) {
      case "message": {
        const text = str(c.text);
        if (text) out.push({ type: "message", key, text });
        break;
      }
      case "buttons": {
        const buttons = actions(c.buttons, 10);
        if (buttons.length) out.push({ type: "buttons", key, buttons });
        break;
      }
      case "card": {
        const title = str(c.title, 200);
        if (title)
          out.push({ type: "card", key, title, body: str(c.body, 2000), imageUrl: safeUrl(c.imageUrl), actions: actions(c.actions, 5) });
        break;
      }
      case "form": {
        const fields: Field[] = (Array.isArray(c.fields) ? c.fields : []).slice(0, 20).flatMap((f) => {
          if (!isObj(f) || !str(f.name, 64) || !FIELD_KINDS.has(f.kind as string)) return [];
          return [
            {
              name: str(f.name, 64)!,
              label: str(f.label, 120) ?? str(f.name, 64)!,
              kind: f.kind as Field["kind"],
              required: f.required === true,
              options: (Array.isArray(f.options) ? f.options : []).filter((o): o is string => typeof o === "string").slice(0, 50),
            },
          ];
        });
        if (fields.length) out.push({ type: "form", key, submitLabel: str(c.submitLabel, 80) || "Submit", fields });
        break;
      }
      case "calendar": {
        const slots = (Array.isArray(c.slots) ? c.slots : []).slice(0, 100).flatMap((s) =>
          isObj(s) && typeof s.start === "string" && typeof s.end === "string" && !isNaN(Date.parse(s.start)) && !isNaN(Date.parse(s.end))
            ? [{ start: s.start, end: s.end }]
            : [],
        );
        if (slots.length) out.push({ type: "calendar", key, timezone: str(c.timezone, 64) ?? "UTC", slots });
        break;
      }
      default: {
        // Unknown component from a newer schema: degrade to its text-ish content if it has any.
        const text = str(c.text) ?? str(c.title) ?? str(c.body);
        if (text) out.push({ type: "message", key, text });
      }
    }
  });
  if (!out.length && fallbackText) out.push({ type: "message", key: `${idPrefix}:fb`, text: fallbackText.slice(0, 4000) });
  return out;
}
