import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Eye, UserRoundCog } from "lucide-react";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Spinner } from "../../components/ui";
import { req } from "../integrations-ui/http";

/**
 * Unmistakable, sticky bar for the whole platform-admin impersonation session. Read-only sessions say so (every change
 * is blocked by the API); write-mode sessions are marked as such. Stacks on phones so "Stop impersonating" stays one thumb away.
 */
export function ImpersonationBanner() {
  const { session, impersonation, logout } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const me = useQuery({ queryKey: ["me-impersonation"], queryFn: () => req<{ impersonation?: { active: boolean; sessionId: string | null; readOnly?: boolean } | null }>("/me"), staleTime: 60_000, retry: false });
  const remote = me.data?.impersonation;
  if (!impersonation && !remote) return null;
  const readOnly = impersonation ? impersonation.readOnly : remote?.readOnly === true;
  const exit = async () => {
    setBusy(true);
    try { await logout(); } catch { /* the session is dropped locally either way */ }
    nav("/login", { replace: true });
  };
  return (
    <div role="alert" className="sticky top-0 z-50 flex flex-col gap-2 border-b-2 border-[#0f1a2f] bg-primary px-4 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] text-sm text-primary-foreground sm:flex-row sm:items-center sm:justify-between">
      <p className="flex min-w-0 items-start gap-2">
        {readOnly ? <Eye className="mt-0.5 size-5 shrink-0" aria-hidden /> : <UserRoundCog className="mt-0.5 size-5 shrink-0" aria-hidden />}
        <span>
          <strong className="font-display font-semibold">{readOnly ? "Impersonating, read-only" : "Impersonating, write mode"}</strong> {impersonation?.tenantName ?? session?.tenant.name} as {session?.user.email}.{" "}
          {readOnly ? "You can look but not change anything." : "Changes you make are real."} Every action is audited and the session ends after 15 minutes.
        </span>
      </p>
      <Button variant="dark" size="sm" className="max-sm:w-full" disabled={busy} onClick={() => void exit()}>{busy && <Spinner />}Stop impersonating</Button>
    </div>
  );
}
