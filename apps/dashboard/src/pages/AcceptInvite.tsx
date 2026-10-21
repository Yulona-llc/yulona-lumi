import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { CircleCheck } from "lucide-react";
import { ApiError, api } from "../api/client";
import { Alert, Field, Spinner } from "../components/ui";
import { AuthLayout } from "../components/AuthLayout";
import { Button } from "@/components/ui/button";

/** Landing page of the invitation email: `/accept-invite?token=...`. Creates the account, then sends the person to sign in. */
export default function AcceptInvite() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get("name")).trim();
    const password = String(f.get("password"));
    const fe: Record<string, string> = {};
    if (!name) fe.name = "Enter your name.";
    if (password.length < 12) fe.password = "Use at least 12 characters.";
    setFieldErr(fe);
    if (Object.keys(fe).length) return;
    setError(null);
    setBusy(true);
    try {
      await api.acceptInvite({ token, name, password });
      setDone(true);
      setTimeout(() => nav("/login", { replace: true }), 1800);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409 ? "This email already has an account. Sign in instead."
        : err instanceof ApiError && err.status === 400 ? "This invitation is invalid, already used or has expired. Ask your administrator to send a new one."
        : err instanceof ApiError ? err.message : "Something went wrong. Try again.",
      );
      setBusy(false);
    }
  }

  if (!token)
    return (
      <AuthLayout title="Invitation link incomplete" subtitle="This link is missing its invitation code.">
        <p className="text-muted-foreground">Open the link from your invitation email again, or ask your administrator for a new invitation. Already have an account? <Link className="font-medium text-accent-foreground underline underline-offset-4" to="/login">Sign in</Link>.</p>
      </AuthLayout>
    );

  if (done)
    return (
      <AuthLayout title="You're in" subtitle="Your account is ready.">
        <p role="status" className="flex items-center gap-2 text-muted-foreground"><CircleCheck className="size-5 text-success" />Taking you to sign in…</p>
      </AuthLayout>
    );

  return (
    <AuthLayout title="Join your team" subtitle="Choose your name and a password to finish setting up your account.">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Your name" name="name" autoComplete="name" required error={fieldErr.name} />
        <Field label="Password" name="password" type="password" autoComplete="new-password" required minLength={12} hint="At least 12 characters." error={fieldErr.password} />
        <Button size="lg" className="w-full" disabled={busy}>{busy && <Spinner />}{busy ? "Creating account" : "Create account"}</Button>
      </form>
      <p className="mt-6 text-sm text-muted-foreground">Already have an account? <Link className="font-medium text-accent-foreground underline underline-offset-4" to="/login">Sign in</Link></p>
    </AuthLayout>
  );
}
