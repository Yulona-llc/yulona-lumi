import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import type { OnboardingStep } from "@yulona/shared";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { isHex, readableOn, SOLID_SWATCHES } from "../widget-config/brand";

/** Props every step component receives. `value` is the draft answer; `onChange` updates it. */
export interface StepProps { step: OnboardingStep; value: unknown; onChange: (v: unknown) => void; error?: string | null }

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function Tick({ on }: { on: boolean }) {
  return <span aria-hidden className={cn("grid size-5 shrink-0 place-items-center rounded-full border", on ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background")}>{on && <Check className="size-3.5" />}</span>;
}

/** One choice out of a few big cards (radio group). */
export function ChoiceCards({ step, value, onChange }: StepProps) {
  return (
    <div role="radiogroup" aria-label={step.title} className="grid gap-3 sm:grid-cols-2">
      {step.options?.map((o) => {
        const on = value === o.value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.value)}
            className={cn("flex min-h-16 items-start gap-3 rounded-2xl border bg-card p-4 text-left outline-none transition-colors hover:border-foreground/40 focus-visible:ring-[3px] focus-visible:ring-ring/50", on && "border-primary bg-accent/50 ring-1 ring-primary")}>
            <Tick on={on} />
            <span className="min-w-0">
              <span className="block font-medium">{o.label}{o.suggested && <span className="ml-2 rounded-full bg-accent px-2 py-0.5 align-middle text-xs font-normal text-accent-foreground">Suggested</span>}</span>
              {o.description && <span className="mt-0.5 block text-sm text-muted-foreground">{o.description}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Several choices as chips (checkbox group), in the order the person picks them. */
export function MultiChips({ step, value, onChange }: StepProps) {
  const sel = Array.isArray(value) ? (value as string[]) : [];
  const toggle = (v: string) => onChange(sel.includes(v) ? sel.filter((x) => x !== v) : step.maxSelect && sel.length >= step.maxSelect ? sel : [...sel, v]);
  return (
    <div role="group" aria-label={step.title} className="flex flex-wrap gap-2.5">
      {step.options?.map((o) => {
        const on = sel.includes(o.value);
        return (
          <button key={o.value} type="button" role="checkbox" aria-checked={on} onClick={() => toggle(o.value)} title={o.description}
            className={cn("flex min-h-11 items-center gap-2 rounded-full border bg-card px-4 text-sm font-medium outline-none transition-colors hover:border-foreground/40 focus-visible:ring-[3px] focus-visible:ring-ring/50", on && "border-primary bg-accent text-accent-foreground ring-1 ring-primary")}>
            <Tick on={on} />{o.label}{o.suggested && !on && <span className="text-xs font-normal text-muted-foreground">suggested</span>}
          </button>
        );
      })}
    </div>
  );
}

export function TextStep({ step, value, onChange, error }: StepProps) {
  return <Labeled step={step} error={error}><Input value={typeof value === "string" ? value : ""} maxLength={step.maxLength} placeholder={step.placeholder} onChange={(e) => onChange(e.target.value)} className="h-12 text-base" autoFocus /></Labeled>;
}
export function UrlStep({ step, value, onChange, error }: StepProps) {
  return <Labeled step={step} error={error}><Input type="url" inputMode="url" value={typeof value === "string" ? value : ""} maxLength={step.maxLength} placeholder={step.placeholder} onChange={(e) => onChange(e.target.value)} className="h-12 text-base" autoFocus /></Labeled>;
}
function Labeled({ step, error, children }: { step: OnboardingStep; error?: string | null; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <label className="sr-only">{step.title}</label>
      {children}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** Brand colour and optional logo. Adapter over the widget settings colour swatches; an uploaded logo is added later in Website widget settings. */
export function BrandStep({ value, onChange, error }: StepProps) {
  const v = (value && typeof value === "object" ? value : {}) as { color?: string; logoUrl?: string };
  const color = v.color ?? "";
  const set = (patch: Partial<typeof v>) => {
    const next = { ...v, ...patch };
    if (!next.logoUrl) delete next.logoUrl;
    onChange(next);
  };
  return (
    <div className="space-y-5">
      <div role="radiogroup" aria-label="Brand colour" className="flex flex-wrap gap-3">
        {SOLID_SWATCHES.map((s) => (
          <button key={s.color} type="button" role="radio" aria-checked={color.toLowerCase() === s.color} aria-label={s.name} onClick={() => set({ color: s.color })}
            className={cn("grid size-12 place-items-center rounded-full border-2 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50", color.toLowerCase() === s.color ? "border-foreground" : "border-transparent")} style={{ background: s.color }}>
            {color.toLowerCase() === s.color && <Check className="size-5" style={{ color: readableOn(s.color) }} />}
          </button>
        ))}
      </div>
      <label className="block text-sm font-medium">Or type a colour
        <Input value={color} onChange={(e) => set({ color: e.target.value })} placeholder="#2563EB" className="mt-1.5 h-11 max-w-48 font-mono" aria-invalid={color !== "" && !isHex(color)} />
      </label>
      <label className="block text-sm font-medium">Logo link (optional)
        <Input type="url" value={v.logoUrl ?? ""} onChange={(e) => set({ logoUrl: e.target.value })} placeholder="https://example.com/logo.png" className="mt-1.5 h-11" />
        <span className="mt-1 block text-sm font-normal text-muted-foreground">You can upload and crop an image later under Website widget.</span>
      </label>
      {color && isHex(color) && (
        <div className="flex items-center gap-3 rounded-2xl border bg-card p-3" aria-label="Preview">
          <span className="grid size-10 place-items-center rounded-full text-sm font-semibold" style={{ background: color, color: readableOn(color) }}>Aa</span>
          <span className="rounded-2xl rounded-bl-sm px-3 py-2 text-sm" style={{ background: color, color: readableOn(color) }}>Hi! How can I help?</span>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

type Hours = { mode: "always" } | { mode: "custom"; timezone: string; days: { weekday: number; start: string; end: string }[] };
const defaultTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } };
const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "09:00", end: "17:00" }));

/** Business hours: always on, or per-day opening times in the visitor's own timezone. */
export function HoursStep({ value, onChange, error }: StepProps) {
  const v: Hours | null = value && typeof value === "object" ? (value as Hours) : null;
  const [tz] = useState(defaultTz);
  const custom = v?.mode === "custom" ? v : null;
  const setDay = (weekday: number, patch: Partial<{ start: string; end: string }> | null) => {
    const base = custom ?? { mode: "custom" as const, timezone: tz, days: [] };
    const rest = base.days.filter((d) => d.weekday !== weekday);
    const cur = base.days.find((d) => d.weekday === weekday);
    const days = patch === null ? rest : [...rest, { weekday, start: cur?.start ?? "09:00", end: cur?.end ?? "17:00", ...patch }].sort((a, b) => a.weekday - b.weekday);
    onChange(days.length ? { ...base, days } : { mode: "always" });
  };
  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Availability" className="grid gap-3 sm:grid-cols-2">
        {[{ k: "always", t: "No fixed hours", d: "Lumi answers any time; no opening hours are set." }, { k: "custom", t: "Set opening hours", d: `Times are in ${custom?.timezone ?? tz}.` }].map((o) => {
          const on = (v?.mode ?? "") === o.k;
          return (
            <button key={o.k} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.k === "always" ? { mode: "always" } : { mode: "custom", timezone: tz, days: WEEKDAYS })}
              className={cn("flex min-h-16 items-start gap-3 rounded-2xl border bg-card p-4 text-left outline-none hover:border-foreground/40 focus-visible:ring-[3px] focus-visible:ring-ring/50", on && "border-primary bg-accent/50 ring-1 ring-primary")}>
              <Tick on={on} /><span><span className="block font-medium">{o.t}</span><span className="block text-sm text-muted-foreground">{o.d}</span></span>
            </button>
          );
        })}
      </div>
      {custom && (
        <ul className="divide-y rounded-2xl border bg-card" aria-label="Opening hours">
          {[1, 2, 3, 4, 5, 6, 0].map((wd) => {
            const d = custom.days.find((x) => x.weekday === wd);
            return (
              <li key={wd} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <label className="flex min-h-11 w-36 items-center gap-2 text-sm font-medium">
                  <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={!!d} onChange={(e) => setDay(wd, e.target.checked ? {} : null)} />{DAYS[wd]}
                </label>
                {d ? (
                  <span className="flex items-center gap-2 text-sm">
                    <input aria-label={`${DAYS[wd]} opens`} type="time" value={d.start} onChange={(e) => setDay(wd, { start: e.target.value })} className="h-10 rounded-lg border bg-background px-2" />
                    to
                    <input aria-label={`${DAYS[wd]} closes`} type="time" value={d.end} onChange={(e) => setDay(wd, { end: e.target.value })} className="h-10 rounded-lg border bg-background px-2" />
                  </span>
                ) : <span className="text-sm text-muted-foreground">Closed</span>}
              </li>
            );
          })}
        </ul>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** Read-only summary of what will be created. */
export function PreviewStep({ step }: StepProps) {
  const lines = (step.help ?? "").split("\n").slice(1).filter(Boolean);
  return (
    <ul className="space-y-2.5" aria-label="What will be created">
      {lines.map((l) => <li key={l} className="flex items-start gap-3 rounded-xl border bg-card p-3.5 text-[0.9375rem]"><Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />{l}</li>)}
    </ul>
  );
}

/** Whitelisted component map: the only UI the wizard can render. Unknown component names render nothing. */
export const STEP_COMPONENTS: Record<string, (p: StepProps) => ReactNode> = {
  choice_cards: ChoiceCards, multi_chips: MultiChips, text: TextStep, url: UrlStep, brand: BrandStep, hours: HoursStep, preview: PreviewStep,
};

/** A step answer is ready to send. */
export function answerReady(step: OnboardingStep, v: unknown): boolean {
  switch (step.component) {
    case "choice_cards": return typeof v === "string" && v !== "";
    case "multi_chips": return Array.isArray(v) && (v.length > 0 || !step.required);
    case "text": return typeof v === "string" && v.trim() !== "";
    case "url": return typeof v === "string" && /^https?:\/\/\S+\.\S+/.test(v.trim());
    case "brand": return !!v && typeof v === "object" && isHex((v as { color?: string }).color);
    case "hours": return !!v && typeof v === "object" && (v as { mode?: string }).mode !== undefined;
    default: return true;
  }
}
