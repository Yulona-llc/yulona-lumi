import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Sparkles } from "lucide-react";
import { ApiError } from "../../api/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { METRIC_LABEL } from "./api";

export interface PlanLimitDetails { metric: string; limit: number | null; used: number }

/** Returns the 402 plan_limit_exceeded details, or null when the error is something else. */
export function planLimitFrom(e: unknown): PlanLimitDetails | null {
  if (e instanceof ApiError && e.status === 402 && e.code === "plan_limit_exceeded") {
    const d = (e.details ?? {}) as Partial<PlanLimitDetails>;
    return { metric: d.metric ?? "usage", limit: d.limit ?? null, used: d.used ?? 0 };
  }
  return null;
}

/**
 * Reusable 402 prompt. Drop it where a create action can fail: `<UpgradePrompt error={mutation.error} />`.
 * Renders nothing unless the error is a plan-limit error; otherwise opens a dialog (a bottom sheet on phones)
 * that shows how full the limit is and links to the plans.
 */
export function UpgradePrompt({ error }: { error: unknown }) {
  const d = planLimitFrom(error);
  const [open, setOpen] = useState(true);
  useEffect(() => { if (error) setOpen(true); }, [error]);
  if (!d) return null;
  const name = METRIC_LABEL[d.metric] ?? d.metric;
  const pct = d.limit ? Math.min(100, (d.used / d.limit) * 100) : 100;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <span className="mb-1 grid size-12 place-items-center rounded-2xl bg-accent text-accent-foreground"><Sparkles className="size-6" /></span>
          <DialogTitle>Plan limit reached</DialogTitle>
          <DialogDescription>You have used all of your {name.toLowerCase()}. Upgrade your plan to keep going.</DialogDescription>
        </DialogHeader>
        <div className="rounded-xl border bg-muted/40 p-4">
          <div className="mb-2 flex items-baseline justify-between text-sm"><span className="font-medium">{name}</span><span className="tabular-nums text-muted-foreground">{d.used}{d.limit !== null ? ` of ${d.limit}` : ""} used</span></div>
          <Progress value={pct} aria-label={`${name} usage`} className="[&>div]:bg-destructive" />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Not now</Button>
          <Button asChild><Link to="/settings/billing">View plans</Link></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
