import { useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import type { OnboardingStep } from "@yulona/shared";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { LogoMark } from "../../components/Logo";
import { useAuth } from "../../auth/AuthProvider";
import { FullPageSpinner, Spinner } from "../../components/ui";
import { errMsg } from "../common/api";
import { ErrorState, Loading, useRole } from "../common/ui";
import { onboardingApi } from "./api";
import { STEP_COMPONENTS, answerReady } from "./steps";

/** Full-screen, resumable setup wizard. Steps come from the server's typed schema; only whitelisted components render. */
export default function OnboardingPage() {
  const { status: auth } = useAuth();
  const { isAdmin } = useRole();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["onboarding"], queryFn: onboardingApi.state, enabled: isAdmin, staleTime: Infinity, retry: false });
  const [idx, setIdx] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [err, setErr] = useState<string | null>(null);
  const state = q.data;
  const steps = state?.steps ?? [];

  // Resume where the person left off (server-side progress).
  useEffect(() => {
    if (state && idx === null) setIdx(Math.max(0, steps.findIndex((s) => s.id === state.currentStepId)));
  }, [state, idx, steps]);

  const save = useMutation({
    mutationFn: (a: { id: string; value: unknown }) => onboardingApi.answer(a.id, a.value),
    onSuccess: (s) => qc.setQueryData(["onboarding"], s),
  });
  const skipAll = useMutation({
    mutationFn: onboardingApi.skip,
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["workspace-profile"] }); nav("/overview", { replace: true }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const finish = useMutation({
    mutationFn: onboardingApi.finish,
    onSuccess: () => { void qc.invalidateQueries(); toast.success("Your starter setup is ready. Try it, then publish."); nav("/overview", { replace: true }); },
    onError: (e) => setErr(errMsg(e)),
  });

  const step: OnboardingStep | undefined = idx === null ? undefined : steps[idx];
  const value = step ? (step.id in drafts ? drafts[step.id] : state?.answers[step.id]) : undefined;
  const Comp = step ? STEP_COMPONENTS[step.component] : undefined;
  const last = idx !== null && idx === steps.length - 1;
  const pct = useMemo(() => (steps.length ? Math.round(((idx ?? 0) / (steps.length - 1)) * 100) : 0), [idx, steps.length]);

  if (auth === "loading") return <FullPageSpinner label="Loading" />;
  if (!isAdmin) return <Navigate to="/overview" replace />;
  if (state?.status === "completed") return <Navigate to="/overview" replace />;

  async function next(skip: boolean) {
    if (!step) return;
    setErr(null);
    try {
      if (!last) await save.mutateAsync({ id: step.id, value: skip ? null : value });
      setDrafts((d) => { const { [step.id]: _drop, ...rest } = d; return rest; });
      if (last) finish.mutate();
      else setIdx((i) => (i ?? 0) + 1);
    } catch (e) { setErr(errMsg(e)); }
  }
  const busy = save.isPending || finish.isPending;
  const ready = !!step && (last || answerReady(step, value));

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b px-4 sm:px-8">
        <span className="flex items-center gap-2 font-display font-semibold"><LogoMark className="size-8" />Set up Lumi</span>
        <Button variant="ghost" size="sm" disabled={skipAll.isPending} onClick={() => skipAll.mutate()}>Skip setup for now</Button>
      </header>
      <div className="h-1 bg-muted" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}><div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${pct}%` }} /></div>
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-8 sm:py-12">
        {q.isPending ? <Loading label="Loading your setup" /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : !step ? null : (
          <section aria-labelledby="step-h" key={step.id}>
            <p className="text-sm text-muted-foreground">Step {(idx ?? 0) + 1} of {steps.length}</p>
            <h1 id="step-h" className="mt-1 font-display text-2xl font-semibold tracking-tight sm:text-3xl">{step.title}</h1>
            {step.help && step.component !== "preview" && <p className="mt-2 text-muted-foreground">{step.help.split("\n")[0]}</p>}
            {step.component === "preview" && <p className="mt-2 text-muted-foreground">{step.help?.split("\n")[0]}</p>}
            <div className="mt-6">{Comp && <Comp step={step} value={value} onChange={(v) => setDrafts((d) => ({ ...d, [step.id]: v }))} error={null} />}</div>
            {err && <p role="alert" className="mt-4 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">{err}</p>}
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Button variant="outline" size="lg" disabled={!idx || busy} onClick={() => setIdx((i) => Math.max(0, (i ?? 0) - 1))}><ArrowLeft />Back</Button>
              <Button size="lg" disabled={!ready || busy} onClick={() => void next(false)} className="min-w-40">
                {busy ? <Spinner /> : last ? <Sparkles /> : null}{last ? (busy ? "Setting up" : "Create my setup") : "Continue"}{!last && !busy && <ArrowRight />}
              </Button>
              {step.skippable && !last && <Button variant="ghost" size="lg" disabled={busy} onClick={() => void next(true)}>Skip this step</Button>}
            </div>
            {last && <p className="mt-4 text-sm text-muted-foreground">Lumi may use one short AI call to polish the wording. It never publishes anything and costs you no credits.</p>}
          </section>
        )}
      </main>
    </div>
  );
}
