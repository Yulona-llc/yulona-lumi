import { useEffect, useState, type ReactNode } from "react";
import { CalendarCheck2, Check } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { Logo } from "./Logo";
import { ThemedLogo } from "./Logo";
import { ease, motion } from "./motion";

/** The sign-in hero is a real conversation, the product's own vernacular: question, grounded answer, booking. */
const SCRIPT = [
  { who: "customer", text: "Do you have a table for 4 on Friday evening?" },
  { who: "agent", text: "Yes, 7:30 pm is open. Want me to hold it under your name?" },
  { who: "customer", text: "Please. Dawit." },
] as const;

function Conversation() {
  const reduce = useReducedMotion();
  const [step, setStep] = useState(reduce ? SCRIPT.length + 1 : 0);
  useEffect(() => {
    if (reduce) return;
    const t = [500, 1500, 2700, 3900].map((ms, i) => setTimeout(() => setStep(i + 1), ms));
    return () => t.forEach(clearTimeout);
  }, [reduce]);
  return (
    <div className="w-full max-w-sm space-y-3" aria-hidden="true">
      {SCRIPT.slice(0, step).map((m, i) => (
        <motion.div key={i} initial={{ opacity: 0, y: 10, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.32, ease }}
          className={m.who === "customer" ? "ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-[#1f3354] px-4 py-2.5 text-sm text-white" : "w-fit max-w-[88%] rounded-2xl rounded-bl-md bg-white/95 px-4 py-2.5 text-sm text-[#0f1a2f]"}>
          {m.text}
        </motion.div>
      ))}
      {step > SCRIPT.length && (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease }}
          className="flex items-center gap-3 rounded-2xl border border-primary/50 bg-primary/12 p-3.5">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground"><CalendarCheck2 className="size-5" /></span>
          <div className="min-w-0 text-sm"><p className="font-semibold text-white">Reservation created</p><p className="text-[#aebcd0]">Fri 7:30 pm · 4 guests · Dawit</p></div>
          <Check className="ml-auto size-5 text-[#25d366]" />
        </motion.div>
      )}
    </div>
  );
}

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="grid min-h-full bg-background lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
      <aside className="relative hidden flex-col justify-between overflow-hidden bg-sidebar p-12 text-white lg:flex">
        <div aria-hidden="true" className="pointer-events-none absolute -right-32 -top-32 size-[34rem] rounded-full bg-primary/25 blur-[110px]" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-40 -left-24 size-[28rem] rounded-full bg-[#1d3b78]/40 blur-[100px]" />
        <Logo light className="relative h-10 self-start" />
        <div className="relative">
          <h2 className="mb-10 max-w-md font-display text-4xl font-semibold leading-[1.1] tracking-tight">Every conversation, traced to a booking.</h2>
          <Conversation />
        </div>
        <p className="relative text-sm text-[#aebcd0]">AI answers first. Your team steps in when it matters.</p>
      </aside>
      <main className="flex flex-col px-5 py-8 sm:px-10 lg:justify-center">
        <div className="mx-auto w-full max-w-sm">
          <div className="mb-10 lg:hidden"><ThemedLogo /></div>
          <h1 className="font-display text-[1.75rem] font-semibold tracking-tight">{title}</h1>
          <p className="mb-8 mt-1.5 text-muted-foreground">{subtitle}</p>
          {children}
        </div>
      </main>
    </div>
  );
}
