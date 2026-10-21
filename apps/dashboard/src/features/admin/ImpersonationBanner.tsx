import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { UserRoundCog } from "lucide-react";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "@/components/ui/button";
import { Spinner } from "../../components/ui";
import { req } from "../integrations-ui/http";
import { impersonation, useImpersonation } from "./impersonation";

/** Unmistakable, sticky ember bar for the whole impersonation session. Stacks on phones so "Stop impersonating" is always one thumb away. */
export function ImpersonationBanner() {
  const local = useImpersonation();
  const { session, logout } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const me = useQuery({ queryKey: ["me-impersonation"], queryFn: () => req<{ impersonation?: { active: boolean; sessionId: string } | null }>("/me"), staleTime: 60_000, retry: false });
  const remote = me.data?.impersonation;
  if (!local && !remote) return null;
  const exit = async () => {
    setBusy(true);
    if (local) await impersonation.end();
    await logout();
    nav("/admin", { replace: true });
  };
  return (
    <div role="alert" className="sticky top-0 z-50 flex flex-col gap-2 border-b-2 border-[#0f1a2f] bg-primary px-4 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] text-sm text-primary-foreground sm:flex-row sm:items-center sm:justify-between">
      <p className="flex min-w-0 items-start gap-2">
        <UserRoundCog className="mt-0.5 size-5 shrink-0" aria-hidden />
        <span><strong className="font-display font-semibold">Impersonating</strong> {local?.tenantName ?? session?.tenant.name} as {session?.user.email}. Every action is audited and the session ends after 15 minutes.</span>
      </p>
      <Button variant="dark" size="sm" className="max-sm:w-full" disabled={busy} onClick={() => void exit()}>{busy && <Spinner />}Stop impersonating</Button>
    </div>
  );
}
