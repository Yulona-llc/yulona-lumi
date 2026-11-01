import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { ApiError } from "../api/client";
import { registerRequestSchema } from "../api/contract";
import { Alert, Field, Spinner } from "../components/ui";
import { Button } from "@/components/ui/button";
import { AuthLayout } from "../components/AuthLayout";

const MSG: Record<string, string> = {
  email: "Enter a valid email address.",
  password: "Use at least 12 characters.",
  name: "Enter your name.",
  workspaceName: "Name your workspace.",
};

export default function Register() {
  const { register } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = registerRequestSchema.safeParse({
      email: String(f.get("email")).trim(),
      password: String(f.get("password")),
      name: String(f.get("name")).trim(),
      workspaceName: String(f.get("workspaceName")).trim(),
    });
    if (!parsed.success) {
      const fe: Record<string, string> = {};
      for (const i of parsed.error.issues) fe[String(i.path[0])] ??= MSG[String(i.path[0])] ?? "Invalid value.";
      setFieldErr(fe);
      return;
    }
    setFieldErr({});
    setError(null);
    setBusy(true);
    try {
      await register(parsed.data);
      nav("/onboarding", { replace: true }); // new workspaces start with the setup wizard (skippable)
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setClosed(true);
      else setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  if (closed)
    return (
      <AuthLayout title="Sign-up is closed" subtitle="This installation does not allow public registration.">
        <p className="text-muted-foreground">Ask your workspace administrator for an invitation, or <Link className="font-medium text-accent-foreground underline underline-offset-4" to="/login">sign in</Link>.</p>
      </AuthLayout>
    );

  return (
    <AuthLayout title="Create your workspace" subtitle="Start answering customers with AI in minutes.">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Your name" name="name" autoComplete="name" required error={fieldErr.name} />
        <Field label="Workspace name" name="workspaceName" autoComplete="organization" required error={fieldErr.workspaceName} />
        <Field label="Work email" name="email" type="email" autoComplete="email" required error={fieldErr.email} />
        <Field label="Password" name="password" type="password" autoComplete="new-password" required minLength={12} hint="At least 12 characters." error={fieldErr.password} />
        <Button size="lg" className="w-full" disabled={busy}>{busy && <Spinner />}{busy ? "Creating" : "Create workspace"}</Button>
      </form>
      <p className="mt-6 text-sm text-muted-foreground">Already have an account? <Link className="font-medium text-accent-foreground underline underline-offset-4" to="/login">Sign in</Link></p>
    </AuthLayout>
  );
}
