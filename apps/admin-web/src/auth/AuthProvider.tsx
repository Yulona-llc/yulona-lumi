import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { adminApi } from "../api/endpoints";
import { refreshSession, setAccessToken, setRestrictedHandler, setSessionLostHandler, type SessionPayload } from "../api/client";
import type { Me } from "../api/types";
import { can as canRole, type Perm } from "./permissions";

type Status = "loading" | "authenticated" | "anonymous";
export type LoginOutcome = { kind: "ok" } | { kind: "two_factor"; challengeToken: string };
interface Ctx {
  status: Status;
  admin: Me | null;
  login: (email: string, password: string) => Promise<LoginOutcome>;
  login2fa: (challengeToken: string, code: { code: string } | { recoveryCode: string }) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-read /auth/me (after a password change or 2FA enrolment). */
  refreshMe: () => Promise<void>;
  can: (p: Perm) => boolean;
}
const AuthCtx = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [admin, setAdmin] = useState<Me | null>(null);
  const qc = useQueryClient();
  const timer = useRef<number | undefined>(undefined);

  const adopt = useCallback((s: SessionPayload | null) => {
    window.clearTimeout(timer.current);
    setAdmin(s?.admin ?? null);
    setStatus(s ? "authenticated" : "anonymous");
    if (s) {
      // Silent refresh one minute before the 15-minute access token expires.
      timer.current = window.setTimeout(() => void refreshSession().then(adopt), Math.max(10, s.expiresIn - 60) * 1000);
    } else {
      setAccessToken(null);
      qc.clear();
    }
  }, [qc]);

  useEffect(() => {
    setSessionLostHandler(() => adopt(null));
    // A restricted-session 403 means the server state changed under us: re-read who we are.
    setRestrictedHandler(() => void adminApi.me().then(setAdmin).catch(() => undefined));
    let live = true;
    void refreshSession().then((s) => live && adopt(s));
    return () => { live = false; setSessionLostHandler(null); setRestrictedHandler(null); window.clearTimeout(timer.current); };
  }, [adopt]);

  const value = useMemo<Ctx>(() => ({
    status, admin,
    login: async (email, password) => {
      const r = await adminApi.login(email, password);
      if (r.twoFactorRequired) return { kind: "two_factor", challengeToken: r.challengeToken };
      setAccessToken(r.accessToken);
      adopt(r);
      return { kind: "ok" };
    },
    login2fa: async (challengeToken, code) => {
      const r = await adminApi.login2fa(challengeToken, code);
      setAccessToken(r.accessToken);
      adopt(r);
    },
    refreshMe: async () => { const s = await refreshSession(); if (s) adopt(s); },
    logout: async () => {
      try { await adminApi.logout(); } catch { /* the cookie may already be gone */ } finally { adopt(null); }
    },
    can: (p) => canRole(admin?.role, p),
  }), [status, admin, adopt]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): Ctx {
  const c = useContext(AuthCtx);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}
