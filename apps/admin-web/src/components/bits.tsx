import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Bucket, CreditsState, Health } from "@/api/types";
import { titleCase } from "@/lib/format";

/** Renders `children` as is when `allowed`; otherwise a disabled copy wrapped in a tooltip saying who may do it. */
export function Gated({ allowed, reason, children }: { allowed: boolean; reason: string; children: ReactElement<{ disabled?: boolean }> }) {
  if (allowed) return children;
  const disabled = isValidElement(children) ? cloneElement(children, { disabled: true }) : children;
  return (
    <Tooltip>
      <TooltipTrigger asChild><span tabIndex={0} className="inline-flex cursor-not-allowed max-sm:flex-1 [&>*]:max-sm:w-full" aria-label={reason}>{disabled}</span></TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

const bucketTone: Record<Bucket, "success" | "warning" | "destructive"> = { healthy: "success", watch: "warning", at_risk: "destructive" };
export const bucketLabel: Record<Bucket, string> = { healthy: "Healthy", watch: "Watch", at_risk: "At risk" };

/** Score + bucket. The word is always shown, never colour alone. */
export function HealthBadge({ health, className }: { health: Health; className?: string }) {
  return <Badge variant={bucketTone[health.bucket]} className={cn("tabular-nums", className)}><span aria-hidden className="size-1.5 rounded-full bg-current" />{health.score} {bucketLabel[health.bucket]}</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  const v = status === "active" ? "success" : status === "suspended" ? "warning" : status === "deleted" || status === "deactivated" || status === "disabled" ? "destructive" : "secondary";
  return <Badge variant={v}>{titleCase(status)}</Badge>;
}

const creditTone: Record<CreditsState, "success" | "warning" | "destructive" | "secondary"> = { ok: "success", low: "warning", exhausted: "destructive", unlimited: "secondary" };
export function CreditsBadge({ state }: { state: CreditsState }) {
  return <Badge variant={creditTone[state]}>{state === "ok" ? "OK" : titleCase(state)}</Badge>;
}

export function DefList({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
      {rows.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>)}
    </dl>
  );
}

export function Section({ title, hint, actions, children, className }: { title: string; hint?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border bg-card", className)}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0"><h2 className="font-display text-[0.95rem] font-semibold">{title}</h2>{hint && <p className="text-xs text-muted-foreground">{hint}</p>}</div>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}
