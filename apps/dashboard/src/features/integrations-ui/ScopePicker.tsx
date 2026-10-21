import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { API_KEY_SCOPES, SCOPE_GROUPS } from "./scopes";

/** Grouped switches for API-key scopes: read and write per resource. Write does not imply read, so both are explicit. */
export function ScopePicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const toggle = (s: string, on: boolean) => onChange(on ? [...value, s] : value.filter((x) => x !== s));
  return (
    <div className="divide-y rounded-xl border">
      {SCOPE_GROUPS.map((g) => {
        const scopes = API_KEY_SCOPES.filter((s) => s.startsWith(`${g.resource}:`));
        return (
          <div key={g.resource} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div><p className="text-sm font-medium">{g.label}</p><p className="text-xs text-muted-foreground">{g.hint}</p></div>
            <div className="flex gap-5">
              {scopes.map((s) => {
                const id = `scope-${s}`;
                return (
                  <div key={s} className="flex min-h-11 items-center gap-2 sm:min-h-9">
                    <Switch id={id} checked={value.includes(s)} onCheckedChange={(v) => toggle(s, v)} />
                    <Label htmlFor={id} className="font-mono text-xs">{s.split(":")[1]}<span className="sr-only"> {g.label}</span></Label>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
