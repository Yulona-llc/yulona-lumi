import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { FullPageSpinner } from "../../components/ui";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Logo } from "../../components/Logo";

/**
 * `/impersonate#code=...`: the only customer-side step of a platform-admin impersonation. The platform admin console opens this URL
 * with a one-time code in the fragment (never sent to a server or logged). We take the code out of the address bar at once, wait for the
 * normal session restore to finish (so it cannot overwrite us), then redeem the code for a 15 minute session.
 */
export default function ImpersonatePage() {
  const { status, startImpersonation } = useAuth();
  const nav = useNavigate();
  const code = useRef<string | null | undefined>(undefined);
  const started = useRef(false);
  const [error, setError] = useState<string | null>(null);

  if (code.current === undefined) {
    code.current = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("code");
    if (window.location.hash) history.replaceState(null, "", window.location.pathname);
  }

  useEffect(() => {
    if (status === "loading" || started.current) return;
    started.current = true;
    if (!code.current) { setError("This link has no impersonation code. Start the session again from the admin console."); return; }
    api.exchangeImpersonation(code.current)
      .then((s) => { startImpersonation(s); nav("/overview", { replace: true }); })
      .catch((e: unknown) => setError(e instanceof ApiError && e.status === 400
        ? "This link is invalid, expired or was already used. Links work once and only for 60 seconds. Start the session again from the admin console."
        : e instanceof Error ? e.message : "Could not start the session."));
  }, [status, startImpersonation, nav]);

  if (!error) return <FullPageSpinner label="Starting the impersonation session" />;
  return (
    <main className="grid min-h-full place-items-center bg-background p-4">
      <Card className="w-full max-w-md gap-4 p-6">
        <Logo />
        <h1 className="font-display text-xl font-semibold">Could not start the session</h1>
        <Alert variant="destructive">{error}</Alert>
        <Button asChild variant="outline"><Link to="/login">Go to sign-in</Link></Button>
      </Card>
    </main>
  );
}
