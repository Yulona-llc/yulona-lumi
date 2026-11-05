import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Date, time and date-time pickers drawn in the platform's own style (the browser's native pickers ignore the theme).
 * Values use the same strings as the native inputs: "YYYY-MM-DD", "HH:mm" and "YYYY-MM-DDTHH:mm", so forms keep their state shape.
 */

const pad = (n: number) => String(n).padStart(2, "0");
export const toYmd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (v: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null;
};
const fmtDate = (v: string) => parseYmd(v)?.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) ?? "";
const fmtTime = (v: string) => {
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  return m ? new Date(2000, 0, 1, Number(m[1]), Number(m[2])).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
};

const triggerClass = "flex min-h-11 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-card px-3 py-2 text-left text-foreground shadow-xs outline-none transition-[border-color,box-shadow] hover:border-foreground/30 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-55 aria-invalid:border-destructive";

type FieldProps = { label: string; hint?: string; error?: string; disabled?: boolean; className?: string; "aria-label"?: string };

function Field({ label, hint, error, id, children }: { label: string; hint?: string; error?: string; id: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {(error || hint) && <p className={cn("text-sm", error ? "text-destructive" : "text-muted-foreground")}>{error ?? hint}</p>}
    </div>
  );
}

function Calendar({ value, min, max, onPick }: { value: string; min?: string; max?: string; onPick: (v: string) => void }) {
  const selected = parseYmd(value);
  const [month, setMonth] = useState(() => { const b = selected ?? new Date(); return new Date(b.getFullYear(), b.getMonth(), 1); });
  const today = toYmd(new Date());
  const cells = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const lead = first.getDay();
    return Array.from({ length: 42 }, (_, i) => new Date(month.getFullYear(), month.getMonth(), 1 - lead + i));
  }, [month]);
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + i).toLocaleDateString(undefined, { weekday: "narrow" })), []);
  const go = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  const blocked = (v: string) => (!!min && v < min) || (!!max && v > max);
  return (
    <div className="w-[17.5rem]">
      <div className="mb-2 flex items-center justify-between">
        <p className="font-display text-sm font-semibold" aria-live="polite">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</p>
        <div className="flex gap-1">
          <button type="button" aria-label="Previous month" className="grid size-8 place-items-center rounded-md hover:bg-accent" onClick={() => go(-1)}><ChevronLeft className="size-4" /></button>
          <button type="button" aria-label="Next month" className="grid size-8 place-items-center rounded-md hover:bg-accent" onClick={() => go(1)}><ChevronRight className="size-4" /></button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center text-xs text-muted-foreground">{weekdays.map((w, i) => <span key={i} className="py-1">{w}</span>)}</div>
      <div className="grid grid-cols-7 gap-0.5" role="grid" aria-label="Choose a day">
        {cells.map((d) => {
          const v = toYmd(d);
          const inMonth = d.getMonth() === month.getMonth();
          const isSel = v === value;
          return (
            <button
              key={v} type="button" disabled={blocked(v)} aria-pressed={isSel} aria-label={d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
              onClick={() => onPick(v)}
              className={cn(
                "grid size-9 place-items-center rounded-md text-sm tabular-nums transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-35",
                !inMonth && "text-muted-foreground/60", v === today && !isSel && "border border-primary/60 font-semibold",
                isSel && "bg-primary font-semibold text-primary-foreground hover:bg-primary",
              )}
            >{d.getDate()}</button>
          );
        })}
      </div>
      <div className="mt-2 flex justify-between border-t pt-2 text-sm">
        <button type="button" className="rounded px-2 py-1 text-muted-foreground hover:text-foreground" onClick={() => onPick("")}>Clear</button>
        <button type="button" disabled={blocked(today)} className="rounded px-2 py-1 font-medium text-primary hover:underline disabled:opacity-40" onClick={() => onPick(today)}>Today</button>
      </div>
    </div>
  );
}

/** Day picker. `value` is "YYYY-MM-DD" or "". */
export function DatePicker({ label, hint, error, value, onChange, min, max, disabled, className, placeholder = "Pick a date", ...p }: FieldProps & { value: string; onChange: (v: string) => void; min?: string; max?: string; placeholder?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <Field label={label} hint={hint} error={error} id={id}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button id={id} type="button" disabled={disabled} aria-invalid={error ? true : undefined} aria-label={p["aria-label"]} className={cn(triggerClass, !value && "text-muted-foreground/70", className)}>
            <span className="truncate">{fmtDate(value) || placeholder}</span><CalendarDays className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-3"><Calendar value={value} min={min} max={max} onPick={(v) => { onChange(v); setOpen(false); }} /></PopoverContent>
      </Popover>
    </Field>
  );
}

const slots = (step: number) => Array.from({ length: Math.floor(1440 / step) }, (_, i) => `${pad(Math.floor((i * step) / 60))}:${pad((i * step) % 60)}`);

function TimeList({ value, step, onPick }: { value: string; step: number; onPick: (v: string) => void }) {
  const list = useMemo(() => { const s = slots(step); return value && !s.includes(value) ? [...s, value].sort() : s; }, [step, value]);
  const sel = useRef<HTMLButtonElement>(null);
  useEffect(() => { sel.current?.scrollIntoView({ block: "center" }); }, []);
  return (
    <div className="max-h-64 w-36 overflow-y-auto" role="listbox" aria-label="Choose a time">
      {list.map((t) => (
        <button key={t} ref={t === value ? sel : undefined} type="button" role="option" aria-selected={t === value} onClick={() => onPick(t)}
          className={cn("block w-full rounded-md px-3 py-1.5 text-left text-sm tabular-nums hover:bg-accent", t === value && "bg-primary font-semibold text-primary-foreground hover:bg-primary")}>{fmtTime(t)}</button>
      ))}
    </div>
  );
}

function TimeTrigger({ id, value, onChange, step, disabled, error, className, ariaLabel }: { id: string; value: string; onChange: (v: string) => void; step: number; disabled?: boolean; error?: boolean; className?: string; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button id={id} type="button" disabled={disabled} aria-invalid={error || undefined} aria-label={ariaLabel} className={cn(triggerClass, !value && "text-muted-foreground/70", className)}>
          <span className="truncate">{fmtTime(value) || "Pick a time"}</span><Clock className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2"><TimeList value={value} step={step} onPick={(v) => { onChange(v); setOpen(false); }} /></PopoverContent>
    </Popover>
  );
}

/** Time picker without a visible label (for rows such as opening hours). `value` is "HH:mm". */
export function TimePickerInline({ value, onChange, step = 15, disabled, error, className, "aria-label": ariaLabel }: { value: string; onChange: (v: string) => void; step?: number; disabled?: boolean; error?: boolean; className?: string; "aria-label": string }) {
  const id = useId();
  return <TimeTrigger id={id} value={value} onChange={onChange} step={step} disabled={disabled} error={error} className={className} ariaLabel={ariaLabel} />;
}

export function TimePicker({ label, hint, error, value, onChange, step = 15, disabled, className }: FieldProps & { value: string; onChange: (v: string) => void; step?: number }) {
  const id = useId();
  return <Field label={label} hint={hint} error={error} id={id}><TimeTrigger id={id} value={value} onChange={onChange} step={step} disabled={disabled} error={!!error} className={className} /></Field>;
}

/** Day plus time. `value` is "YYYY-MM-DDTHH:mm" (local time) or "". Picking a day first fills 09:00 so the value is complete. */
export function DateTimePicker({ label, hint, error, value, onChange, min, step = 5, disabled }: FieldProps & { value: string; onChange: (v: string) => void; min?: string; step?: number }) {
  const [d = "", t = ""] = value.split("T");
  const id = useId();
  const dayId = `${id}-d`;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={dayId}>{label}</Label>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <button id={dayId} type="button" disabled={disabled} aria-label={`${label} date`} aria-invalid={error ? true : undefined} className={cn(triggerClass, !d && "text-muted-foreground/70")}>
              <span className="truncate">{fmtDate(d) || "Pick a date"}</span><CalendarDays className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-3"><Calendar value={d} min={min?.slice(0, 10)} onPick={(v) => onChange(v ? `${v}T${t || "09:00"}` : "")} /></PopoverContent>
        </Popover>
        <TimeTrigger id={`${id}-t`} value={t} step={step} disabled={disabled || !d} error={!!error} className="w-36" ariaLabel={`${label} time`} onChange={(v) => onChange(`${d}T${v}`)} />
      </div>
      {(error || hint) && <p className={cn("text-sm", error ? "text-destructive" : "text-muted-foreground")}>{error ?? hint}</p>}
    </div>
  );
}
