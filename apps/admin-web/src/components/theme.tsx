import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

type Theme = "light" | "dark" | "system";
interface Ctx { theme: Theme; resolved: "light" | "dark"; setTheme: (t: Theme) => void }
const ThemeCtx = createContext<Ctx>({ theme: "system", resolved: "light", setTheme: () => {} });
const KEY = "lumi-admin-theme";

const read = (): Theme => {
  try { const v = localStorage.getItem(KEY); return v === "light" || v === "dark" || v === "system" ? v : "system"; } catch { return "system"; }
};
const systemDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(read);
  const [sys, setSys] = useState(systemDark);
  const resolved = theme === "system" ? (sys ? "dark" : "light") : theme;

  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSys(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#070e1b" : "#0f1a2f");
  }, [resolved]);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try { localStorage.setItem(KEY, t); } catch { /* private mode */ }
  }, []);
  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}
export const useTheme = () => useContext(ThemeCtx);
