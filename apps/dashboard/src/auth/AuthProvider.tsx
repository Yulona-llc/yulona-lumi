import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, refreshSession, setSessionLostHandler, setImpersonationToken } from "../api/client";
import type { ImpersonationSession, LoginRequest, RegisterRequest, Session } from "../api/contract";

type Status = "loading" | "authenticated" | "anonymous";
export interface ImpersonationInfo { sessionId: string; readOnly: boolean; tenantName: string }
interface Ctx {
  status: Status;
  /** Set while this tab runs a platform-admin impersonation session (read-only or write mode). */
  impersonation: ImpersonationInfo | null;
  session: Session | null;
  login: (b: LoginRequest) => Promise<void>;
  register: (b: RegisterRequest) => Promise<void>;
  logout: () => Promise<void>;
  /** Adopt a platform-admin impersonation session (no refresh timer; token expires on its own). */
  startImpersonation: (s: ImpersonationSession) => void;
  /** Re-read the session (workspace name, role) after a change that the token carries. */
  refreshProfile: () => Promise<void>;
}
const AuthCtx = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [impersonation, setImpersonation] = useState<ImpersonationInfo | null>(null);
  const qc = useQueryClient();
  const timer = useRef<number | undefined>(undefined);

  const adopt = useCallback((s: Session | null) => {
    window.clearTimeout(timer.current);
    setSession(s);
    setStatus(s ? "authenticated" : "anonymous");
    if (s) setImpersonation(null);
    if (s) {
      // Silent refresh one minute before the access token expires.
      timer.current = window.setTimeout(() => void refreshSession().then(adopt), Math.max(10, s.expiresIn - 60) * 1000);
    } else { qc.clear(); setImpersonation(null); }
  }, [qc]);

  useEffect(() => {
    setSessionLostHandler(() => adopt(null));
    let live = true;
    void refreshSession().then((s) => live && adopt(s));
    return () => {
      live = false;
      setSessionLostHandler(null);
      window.clearTimeout(timer.current);
    };
  }, [adopt]);

  const value = useMemo<Ctx>(
    () => ({
      status,
      session,
      impersonation,
      login: async (b) => adopt(await api.login(b)),
      register: async (b) => adopt(await api.register(b)),
      refreshProfile: async () => { const s = await refreshSession(); if (s) adopt(s); },
      startImpersonation: (s) => {
        window.clearTimeout(timer.current);
        qc.clear();
        setImpersonationToken(s.accessToken);
        setSession({ accessToken: s.accessToken, expiresIn: s.expiresIn, user: s.user, tenant: s.tenant });
        setImpersonation({ sessionId: s.sessionId, readOnly: s.readOnly, tenantName: s.tenant.name });
        setStatus("authenticated");
      },
      logout: async () => {
        try {
          setImpersonationToken(null);
          await api.logout();
        } finally {
          adopt(null);
        }
      },
    }),
    [status, session, impersonation, adopt, qc],
  );
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): Ctx {
  const c = useContext(AuthCtx);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}
