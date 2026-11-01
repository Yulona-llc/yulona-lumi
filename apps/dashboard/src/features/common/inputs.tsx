import { useId, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

type FieldProps = { label: string; hint?: string; error?: string };

/** Shared label / hint / error shell (same look as the other form fields). */
function Shell({ id, label, hint, error, children }: FieldProps & { id: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {(error || hint) && <p id={`${id}-d`} className={cn("text-sm", error ? "text-destructive" : "text-muted-foreground")}>{error ?? hint}</p>}
    </div>
  );
}

/**
 * Type a value and press Enter (or comma, or leave the field) to add it as a chip. Pasting a list splits it.
 * `check` returns an error sentence for a bad entry, which is shown instead of adding it.
 */
export function ChipInput({ label, hint, values, onChange, check, normalize = (v) => v.trim(), placeholder, max = 50, disabled, addLabel = "Add" }: FieldProps & {
  values: string[]; onChange: (v: string[]) => void; check?: (v: string) => string | null; normalize?: (v: string) => string;
  placeholder?: string; max?: number; disabled?: boolean; addLabel?: string;
}) {
  const id = useId();
  const [text, setText] = useState("");
  const [bad, setBad] = useState<string | undefined>();
  const add = (raw: string) => {
    const parts = raw.split(/[\n,]+/).map(normalize).filter(Boolean);
    if (!parts.length) return;
    const next = [...values];
    for (const p of parts) {
      const e = p.length > 100 ? "That is too long. Keep it under 100 characters." : check?.(p);
      if (e) { setBad(e); setText(p); onChange(next); return; }
      if (next.length >= max) { setBad(`You can add up to ${max}.`); setText(p); onChange(next); return; }
      if (!next.some((x) => x.toLowerCase() === p.toLowerCase())) next.push(p);
    }
    setBad(undefined); setText(""); onChange(next);
  };
  return (
    <Shell id={id} label={label} hint={hint} error={bad}>
      <div className={cn("flex flex-wrap items-center gap-1.5 rounded-xl border bg-card p-1.5 focus-within:ring-[3px] focus-within:ring-ring/40", disabled && "opacity-60", bad && "border-destructive")}>
        {values.map((v) => (
          <span key={v} className="inline-flex min-h-8 items-center gap-1 rounded-lg bg-muted py-0.5 pl-2.5 pr-1 text-sm">
            {v}
            {!disabled && <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} aria-label={`Remove ${v}`} className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground"><X className="size-3.5" /></button>}
          </span>
        ))}
        <input
          id={id} value={text} disabled={disabled} placeholder={values.length ? "" : placeholder} autoComplete="off" spellCheck={false} aria-invalid={bad ? true : undefined} aria-describedby={bad || hint ? `${id}-d` : undefined}
          onChange={(e) => { setText(e.target.value); if (bad) setBad(undefined); if (/[,\n]/.test(e.target.value)) add(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(text); }
            else if (e.key === "Backspace" && !text && values.length) onChange(values.slice(0, -1));
          }}
          onBlur={() => add(text)}
          className="min-h-9 min-w-32 flex-1 bg-transparent px-2 text-[0.9375rem] outline-none placeholder:text-muted-foreground"
        />
        {!disabled && text.trim() && <button type="button" onClick={() => add(text)} className="mr-1 min-h-8 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground">{addLabel}</button>}
      </div>
    </Shell>
  );
}

/** A real slider with plain words at both ends. `value` undefined means "not set" (the workspace default). */
export function WordSlider({ label, hint, value, onChange, min = 0, max = 2, step = 0.1, left, right, describe, disabled }: FieldProps & {
  value: number | undefined; onChange: (v: number | undefined) => void; min?: number; max?: number; step?: number; left: string; right: string; describe: (v: number) => string; disabled?: boolean;
}) {
  const id = useId();
  const v = value ?? (min + max) / 2;
  return (
    <Shell id={id} label={label} hint={hint}>
      <div className="grid gap-1.5">
        <input id={id} type="range" min={min} max={max} step={step} value={v} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}
          aria-valuetext={value === undefined ? "Default" : describe(value)} aria-describedby={hint ? `${id}-d` : undefined} className="h-9 w-full cursor-pointer accent-primary disabled:cursor-not-allowed" />
        <div className="flex items-center justify-between text-xs text-muted-foreground"><span>{left}</span><span className="font-medium text-foreground">{value === undefined ? "Workspace default" : describe(value)}</span><span>{right}</span></div>
        {value !== undefined && !disabled && <button type="button" onClick={() => onChange(undefined)} className="w-fit text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">Use the workspace default</button>}
      </div>
    </Shell>
  );
}

/** Type to search a long list (for example time zones). Works with the keyboard; the value is always one of `options` (plus the current one). */
export function SearchSelect({ label, hint, value, onChange, options, disabled, placeholder = "Search" }: FieldProps & { value: string; onChange: (v: string) => void; options: string[]; disabled?: boolean; placeholder?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const all = useMemo(() => [...new Set([value, ...options].filter(Boolean))], [value, options]);
  return (
    <Shell id={id} label={label} hint={hint}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button id={id} type="button" role="combobox" aria-expanded={open} aria-haspopup="listbox" disabled={disabled} aria-describedby={hint ? `${id}-d` : undefined}
            className="field flex items-center justify-between gap-2 text-left disabled:opacity-60"><span className="truncate">{value || "Choose"}</span><ChevronDown className="size-4 shrink-0 text-muted-foreground" /></button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(22rem,calc(100vw-2rem))] p-0">
          <Command>
            <CommandInput placeholder={placeholder} />
            <CommandList>
              <CommandEmpty>Nothing matches.</CommandEmpty>
              <CommandGroup>
                {all.map((o) => (
                  <CommandItem key={o} value={o} onSelect={() => { onChange(o); setOpen(false); }}>
                    <Check className={cn("size-4", o === value ? "opacity-100" : "opacity-0")} />{o}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </Shell>
  );
}

/** Collapsed-by-default section for options most people never change. */
export function Advanced({ title = "Advanced", summary, children, defaultOpen }: { title?: string; summary?: string; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group rounded-xl border bg-muted/30">
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
        <span>{title}{summary && <span className="ml-2 font-normal text-muted-foreground">{summary}</span>}</span>
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-4 border-t p-4">{children}</div>
    </details>
  );
}
