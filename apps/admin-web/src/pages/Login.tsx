import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ThemedLogo } from "@/components/Logo";
import { Spinner, TextField } from "@/components/common";
import { useAuth } from "@/auth/AuthProvider";
import { errMsg } from "@/lib/errors";

export default function Login() {
  const { login, login2fa } = useAuth();
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr("");
    try { await fn(); } catch (x) { setErr(errMsg(x)); } finally { setBusy(false); }
  };
  return (
    <main className="grid min-h-full place-items-center bg-background p-4">
      <Card className="w-full max-w-sm gap-5 p-6 shadow-lg">
        {challenge === null ? (
          <form className="contents" onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await login(email.trim(), pw); if (r.kind === "two_factor") { setChallenge(r.challengeToken); setCode(""); } }); }}>
            <ThemedLogo />
            <div>
              <h1 className="flex items-center gap-2 font-display text-2xl font-semibold tracking-tight"><ShieldCheck className="size-6 text-primary" aria-hidden />Platform admin</h1>
              <p className="mt-1 text-sm text-muted-foreground">Sign in with your operator account. Customer workspace accounts do not work here.</p>
            </div>
            {err && <Alert variant="destructive">{err}</Alert>}
            <TextField label="Email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            <TextField label="Password" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
            <Button disabled={busy}>{busy && <Spinner />}Sign in</Button>
          </form>
        ) : (
          <form className="contents" onSubmit={(e) => { e.preventDefault(); void run(() => login2fa(challenge, recovery ? { recoveryCode: code.trim() } : { code: code.trim() })); }}>
            <ThemedLogo />
            <div>
              <h1 className="font-display text-2xl font-semibold tracking-tight">Two-factor code</h1>
              <p className="mt-1 text-sm text-muted-foreground">{recovery ? "Enter one of your recovery codes. Each works once." : "Enter the 6-digit code from your authenticator app."}</p>
            </div>
            {err && <Alert variant="destructive">{err}</Alert>}
            <TextField label={recovery ? "Recovery code" : "Code"} inputMode={recovery ? "text" : "numeric"} autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus className="font-mono tracking-widest" maxLength={recovery ? 40 : 6} />
            <Button disabled={busy}>{busy && <Spinner />}Verify</Button>
            <div className="flex justify-between text-sm">
              <button type="button" className="font-medium underline underline-offset-4" onClick={() => { setRecovery((r) => !r); setCode(""); setErr(""); }}>{recovery ? "Use an authenticator code" : "Use a recovery code"}</button>
              <button type="button" className="text-muted-foreground underline underline-offset-4" onClick={() => { setChallenge(null); setErr(""); setPw(""); }}>Start over</button>
            </div>
          </form>
        )}
      </Card>
    </main>
  );
}
