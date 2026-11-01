import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Copy, Download, ShieldCheck, ShieldOff } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { adminApi } from "@/api/endpoints";
import { useAuth } from "@/auth/AuthProvider";
import { ConfirmModal, Modal, Spinner, TextField } from "@/components/common";
import { errMsg } from "@/lib/errors";

function Qr({ url }: { url: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let live = true;
    void import("qrcode").then((m) => m.toDataURL(url, { margin: 1, width: 192 })).then((s) => live && setSrc(s)).catch(() => undefined);
    return () => { live = false; };
  }, [url]);
  return src ? <img src={src} alt="QR code for your authenticator app" width={192} height={192} className="rounded-lg border bg-white p-1" /> : <div className="skeleton size-48" />;
}

export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = codes.join("\n");
  const save = () => {
    const url = URL.createObjectURL(new Blob([`Lumi platform admin recovery codes\n\n${text}\n`], { type: "text/plain" }));
    const a = document.createElement("a"); a.href = url; a.download = "lumi-admin-recovery-codes.txt"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="space-y-4">
      <Alert variant="warning"><div><p className="font-semibold">Save these recovery codes now</p><p className="text-muted-foreground">They are shown once. Each code signs you in once if you lose your authenticator.</p></div></Alert>
      <ul className="grid grid-cols-2 gap-2 rounded-xl border bg-muted/40 p-4 font-mono text-sm" aria-label="Recovery codes">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void navigator.clipboard?.writeText(text).then(() => toast.success("Copied"))}><Copy aria-hidden />Copy</Button>
        <Button variant="outline" onClick={save}><Download aria-hidden />Download</Button>
        <Button className="ml-auto" onClick={onDone}>I saved them</Button>
      </div>
    </div>
  );
}

/** TOTP enrolment (password, QR + secret, confirm code, recovery codes) and disable. Used on the account page and in the required-enrolment flow. */
export default function TwoFactorPanel({ onEnrolled }: { onEnrolled?: () => void }) {
  const { admin, refreshMe } = useAuth();
  const [step, setStep] = useState<"idle" | "password" | "scan" | "codes" | "disable">("idle");
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [dpw, setDpw] = useState("");
  const [dcode, setDcode] = useState("");

  const start = useMutation({ mutationFn: () => adminApi.twoFaSetup(password), onSuccess: (r) => { setSetup(r); setPassword(""); setCode(""); setStep("scan"); } });
  const confirm = useMutation({ mutationFn: () => adminApi.twoFaConfirm(code), onSuccess: (r) => { setCodes(r.recoveryCodes); setStep("codes"); } });
  const disable = useMutation({ mutationFn: () => adminApi.twoFaDisable(dpw, /^\d{6}$/.test(dcode.trim()) ? { code: dcode.trim() } : { recoveryCode: dcode.trim() }), onSuccess: async () => { toast.success("Two-factor authentication turned off"); setStep("idle"); setDpw(""); setDcode(""); await refreshMe(); } });
  const finish = async () => { setStep("idle"); setSetup(null); await refreshMe(); onEnrolled?.(); };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {admin?.twoFactorEnabled ? <Badge variant="success"><ShieldCheck aria-hidden />Enabled</Badge> : <Badge variant="secondary"><ShieldOff aria-hidden />Not enabled</Badge>}
        <p className="text-sm text-muted-foreground">{admin?.twoFactorEnabled ? "A code from your authenticator app is asked at every sign-in." : "Add an authenticator app (TOTP) as a second step at sign-in."}</p>
      </div>
      {!admin?.twoFactorEnabled ? <Button onClick={() => setStep("password")}><ShieldCheck aria-hidden />Set up two-factor</Button> : <Button variant="outline" onClick={() => setStep("disable")}>Turn off two-factor</Button>}

      {step === "password" && (
        <Modal title="Confirm your password" description="Required before a new authenticator secret is created." onClose={() => setStep("idle")}>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); start.mutate(); }}>
            {start.isError && <Alert variant="destructive">{errMsg(start.error)}</Alert>}
            <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus />
            <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setStep("idle")}>Cancel</Button><Button disabled={start.isPending}>{start.isPending && <Spinner />}Continue</Button></div>
          </form>
        </Modal>
      )}
      {step === "scan" && setup && (
        <Modal title="Scan the QR code" description="Use Google Authenticator, 1Password, Authy or any TOTP app." onClose={() => setStep("idle")}>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); confirm.mutate(); }}>
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
              <Qr url={setup.otpauthUrl} />
              <div className="min-w-0 text-sm"><p className="text-muted-foreground">Cannot scan? Enter this key by hand:</p><p className="mt-1 break-all rounded-lg border bg-muted/40 p-2 font-mono text-xs" data-testid="totp-secret">{setup.secret}</p></div>
            </div>
            {confirm.isError && <Alert variant="destructive">{errMsg(confirm.error)}</Alert>}
            <TextField label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required className="font-mono tracking-widest" autoFocus />
            <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setStep("idle")}>Cancel</Button><Button disabled={confirm.isPending || code.length !== 6}>{confirm.isPending && <Spinner />}Turn on</Button></div>
          </form>
        </Modal>
      )}
      {step === "codes" && <Modal title="Recovery codes" onClose={() => void finish()}><RecoveryCodes codes={codes} onDone={() => void finish()} /></Modal>}
      {step === "disable" && (
        <ConfirmModal danger title="Turn off two-factor?" confirm="Turn off" busy={disable.isPending} onClose={() => setStep("idle")} onConfirm={() => disable.mutate()}
          body={<form className="space-y-3" onSubmit={(e) => { e.preventDefault(); disable.mutate(); }}>
            {disable.isError && <Alert variant="destructive">{errMsg(disable.error)}</Alert>}
            <TextField label="Password" type="password" autoComplete="current-password" value={dpw} onChange={(e) => setDpw(e.target.value)} />
            <TextField label="Authenticator or recovery code" value={dcode} onChange={(e) => setDcode(e.target.value)} className="font-mono" />
          </form>} />
      )}
    </div>
  );
}
