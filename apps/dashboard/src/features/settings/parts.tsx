import { useEffect, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** True when the viewport matches the media query. Safe where matchMedia is missing (tests). */
export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);
  const [match, setMatch] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** Section header + fields: the one pattern every settings form follows. */
export function FormSection({ title, description, children, className, aside }: { title: string; description?: string; children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <section className={cn("rounded-2xl border bg-card", className)}>
      <header className="flex items-start justify-between gap-3 border-b px-4 py-3.5 sm:px-5">
        <div className="min-w-0">
          <h2 className="font-display text-base font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {aside}
      </header>
      <div className="space-y-4 p-4 sm:p-5">{children}</div>
    </section>
  );
}

/**
 * Save / publish bar. On phones it floats just above the tab bar so the thumb reaches it; on desktop it sticks to the bottom of the page.
 * Pass `show={dirty}` to reveal it only when there is something to save.
 */
export function StickyBar({ show = true, children, className }: { show?: boolean; children: ReactNode; className?: string }) {
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          key="bar"
          initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 24, opacity: 0 }} transition={{ duration: 0.2 }}
          className={cn(
            "sticky bottom-[calc(env(safe-area-inset-bottom)-2rem)] z-20 -mx-4 mt-6 flex items-center gap-2 border-t bg-card/95 px-4 py-2.5 backdrop-blur-md sm:-mx-6 sm:px-6 md:-bottom-7 md:mx-0 md:rounded-2xl md:border md:px-4 md:shadow-lg",
            className,
          )}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Amber dot + text shown while the form differs from what is saved. */
export function DirtyDot({ label = "Unsaved changes", short = "Unsaved" }: { label?: string; short?: string }) {
  return (
    <span role="status" aria-live="polite" className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
      <span className="size-2 shrink-0 rounded-full bg-warning" aria-hidden />
      <span className="truncate sm:hidden">{short}</span>
      <span className="hidden truncate sm:inline">{label}</span>
    </span>
  );
}

export async function copyText(text: string, what = "Copied"): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what);
    return true;
  } catch {
    toast.error("Could not copy. Select the text and copy it by hand.");
    return false;
  }
}

export function CopyButton({ text, label = "Copy", what, variant = "outline", size = "sm" }: { text: string; label?: string; what?: string; variant?: "outline" | "ghost" | "secondary" | "default"; size?: "sm" | "default" }) {
  const [done, setDone] = useState(false);
  return (
    <Button type="button" variant={variant} size={size} onClick={async () => { if (await copyText(text, what ?? `${label === "Copy" ? "Copied" : label}`)) { setDone(true); setTimeout(() => setDone(false), 1800); } }}>
      {done ? <Check className="text-success" /> : <Copy />}{done ? "Copied" : label}
    </Button>
  );
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
}
