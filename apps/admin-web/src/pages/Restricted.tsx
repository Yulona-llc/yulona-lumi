import { LogOut } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ThemedLogo } from "@/components/Logo";
import { useAuth } from "@/auth/AuthProvider";
import { PasswordForm } from "./Account";
import TwoFactorPanel from "./TwoFactorPanel";

/** Restricted session: only the step the server asks for is reachable (everything else answers 403 session_restricted). */
export default function Restricted() {
  const { admin, refreshMe, logout } = useAuth();
  const pw = admin?.restricted === "password_change";
  return (
    <main className="grid min-h-full place-items-center bg-background p-4">
      <Card className="w-full max-w-md gap-5 p-6 shadow-lg">
        <ThemedLogo />
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">{pw ? "Choose a new password" : "Set up two-factor authentication"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{pw ? "Your password was set by an owner. Pick your own before continuing." : "Two-factor authentication is required for every admin. Set it up to continue."}</p>
        </div>
        <Alert variant="info" role="status"><div>Signed in as {admin?.email}. The rest of the console unlocks after this step.</div></Alert>
        {pw ? <PasswordForm forced onDone={() => void refreshMe()} /> : <TwoFactorPanel onEnrolled={() => void refreshMe()} />}
        <Button variant="ghost" size="sm" className="self-start" onClick={() => void logout()}><LogOut aria-hidden />Sign out</Button>
      </Card>
    </main>
  );
}
