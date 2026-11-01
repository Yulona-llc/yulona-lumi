import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { adminApi } from "@/api/endpoints";
import { useAuth } from "@/auth/AuthProvider";
import { roleLabel } from "@/auth/permissions";
import { PageHeader, Spinner, TextField } from "@/components/common";
import { Section } from "@/components/bits";
import { errMsg } from "@/lib/errors";
import TwoFactorPanel from "./TwoFactorPanel";

export function PasswordForm({ onDone, forced }: { onDone?: () => void; forced?: boolean }) {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const m = useMutation({ mutationFn: () => adminApi.changePassword(cur, next), onSuccess: () => { toast.success("Password changed"); setCur(""); setNext(""); setAgain(""); onDone?.(); } });
  const mismatch = again !== "" && again !== next;
  return (
    <form className="grid max-w-md gap-4" onSubmit={(e) => { e.preventDefault(); if (!mismatch) m.mutate(); }}>
      {m.isError && <Alert variant="destructive">{errMsg(m.error)}</Alert>}
      <TextField label={forced ? "Temporary password" : "Current password"} type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
      <TextField label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} maxLength={128} hint="12 to 128 characters." />
      <TextField label="Repeat the new password" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required error={mismatch ? "Passwords do not match" : undefined} />
      <div><Button disabled={m.isPending || mismatch || !cur || next.length < 12}>{m.isPending && <Spinner />}Change password</Button></div>
    </form>
  );
}

export default function Account() {
  const { admin, refreshMe } = useAuth();
  return (
    <div className="max-w-3xl space-y-5">
      <PageHeader title="Your account" subtitle={`${admin?.name} (${admin?.email}), ${admin ? roleLabel[admin.role] : ""} role.`} />
      <Section title="Password" hint="Changing it signs out your other sessions."><PasswordForm onDone={() => void refreshMe()} /></Section>
      <Section title="Two-factor authentication"><TwoFactorPanel /></Section>
    </div>
  );
}
