import { useEffect, useState } from "react";

/** True from the `md` breakpoint (768px) up. Phones and small tablets get the touch-first layouts. */
export function useIsDesktop(query = "(min-width: 768px)"): boolean {
  const get = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false);
  const [v, setV] = useState(get);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setV(m.matches);
    on();
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, [query]);
  return v;
}

/** A clock that re-renders its caller every `ms`, so "waiting 12 min" counters stay live. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export const initials = (name: string | null | undefined) =>
  (name ?? "").split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
