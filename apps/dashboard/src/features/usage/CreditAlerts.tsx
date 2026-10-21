import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { AlertTriangle, PauseCircle, Sparkles, TrendingUp } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { AnimatedNumber } from "@/components/motion";
import { cn } from "@/lib/utils";
import { useRole } from "../common/ui";
import { BuyCreditsDialog } from "./BuyCreditsDialog";
import { fmtCredits, toCredits } from "./api";
import { useCredits } from "./hooks";

/** 80% and 100% states as Alerts. SaaS only; renders nothing when credits are off, unlimited or healthy. */
export function CreditAlerts({ showUsageLink = true, showBuy = true, className }: { showUsageLink?: boolean; showBuy?: boolean; className?: string }) {
  const q = useCredits();
  const { isAdmin } = useRole();
  const [buy, setBuy] = useState(false);
  const c = q.data;
  if (!c || !c.enabled || c.unlimited || c.status === "ok") return null;
  const out = c.status === "exhausted";
  const actions = !((isAdmin && showBuy) || out || showUsageLink) ? null : (
    <div className="col-start-2 mt-2 flex flex-wrap gap-2">
      {isAdmin && showBuy && <Button size="sm" onClick={() => setBuy(true)}><Sparkles aria-hidden />Buy credits</Button>}
      {out && <Button size="sm" variant="outline" asChild><Link to="/attention">Open needs attention</Link></Button>}
      {showUsageLink && <Button size="sm" variant="ghost" asChild><Link to="/settings/usage">View usage</Link></Button>}
    </div>
  );
  return (
    <div className={className}>
      {out ? (
        <Alert variant="destructive"><PauseCircle /><AlertTitle>AI replies are paused</AlertTitle>
          <AlertDescription>You have used all your AI credits. Customers see a short notice and their chats wait in Needs attention until you add credits{isAdmin ? "." : "; ask an admin to buy a pack."}</AlertDescription>{actions}</Alert>
      ) : (
        <Alert variant="warning" role="status"><TrendingUp /><AlertTitle>You have used {Math.round(c.percentUsed ?? 80)}% of your AI credits</AlertTitle>
          <AlertDescription>{fmtCredits(c.remainingMicro)} credits left. AI replies pause at zero{isAdmin ? ", so top up before then." : "; ask an admin to top up before then."}</AlertDescription>{actions}</Alert>
      )}
      {buy && <BuyCreditsDialog onClose={() => setBuy(false)} />}
    </div>
  );
}

/** Slim global bar above every page while credits are exhausted (SaaS). Hidden on the Usage page, which says it in full. */
export function CreditsBanner() {
  const q = useCredits({ poll: true });
  const { pathname } = useLocation();
  const { isAdmin } = useRole();
  const c = q.data;
  if (!c || !c.enabled || c.status !== "exhausted" || pathname.startsWith("/settings/usage")) return null;
  return (
    <div role="alert" className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-destructive px-4 py-2 text-center text-sm font-medium text-white">
      <span className="inline-flex items-center gap-2"><AlertTriangle className="size-4 shrink-0" aria-hidden />AI replies are paused until you add credits</span>
      <Link to="/settings/usage" className="underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-white/70">{isAdmin ? "Add credits" : "View usage"}</Link>
    </div>
  );
}

/** Compact card for the Overview page. Hidden when credits are off or the plan is unlimited. */
export function CreditsCard() {
  const q = useCredits();
  const c = q.data;
  if (q.isPending) return <Skeleton className="h-28 rounded-xl" />;
  if (!c || !c.enabled || c.unlimited) return null;
  const pct = Math.max(0, Math.min(100, c.percentUsed ?? 0));
  return (
    <section aria-labelledby="credits-h">
      <Card className="gap-3 p-5" data-testid="credits-card">
        <div className="flex items-baseline justify-between gap-2">
          <h2 id="credits-h" className="font-display text-lg font-semibold">AI credits</h2>
          <Link to="/settings/usage" className="text-sm font-medium text-accent-foreground underline-offset-4 hover:underline">View usage</Link>
        </div>
        <p className="font-display text-3xl font-semibold tabular-nums"><AnimatedNumber value={toCredits(c.remainingMicro ?? 0)} format={(n) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(Math.round(n))} /> <span className="text-base font-normal text-muted-foreground">left</span></p>
        <Progress value={pct} aria-label="AI credits used" className={cn("h-2", c.status === "warning" && "[&>div]:bg-warning", c.status === "exhausted" && "[&>div]:bg-destructive")} />
        <p className="text-sm text-muted-foreground">{Math.round(pct)}% used this month{c.status === "exhausted" ? ". AI replies are paused." : ""}</p>
      </Card>
    </section>
  );
}

/** Billing return URL (`?credits=success|cancelled`): say what happened, then drop the parameter. */
export function CreditsReturnToast() {
  const { search, pathname } = useLocation();
  const nav = useNavigate();
  useEffect(() => {
    const v = new URLSearchParams(search).get("credits");
    if (v !== "success" && v !== "cancelled") return;
    if (v === "success") toast.success("Credits added. AI replies resume as soon as the payment clears."); else toast("Checkout canceled. No credits were added.");
    nav(pathname, { replace: true });
  }, [search, pathname, nav]);
  return null;
}
