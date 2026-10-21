import { useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthProvider";
import { ApiError } from "../api/client";
import { loginRequestSchema } from "../api/contract";
import { Alert, Field, Spinner } from "../components/ui";
import { Button } from "@/components/ui/button";
import { AuthLayout } from "../components/AuthLayout";

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? "/overview";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const parsed = loginRequestSchema.safeParse({ email: String(f.get("email")).trim(), password: String(f.get("password")) });
    if (!parsed.success) {
      const fe: Record<string, string> = {};
      for (const i of parsed.error.issues) fe[String(i.path[0])] = i.path[0] === "email" ? "Enter a valid email address." : "Enter your password.";
      setFieldErr(fe);
      return;
    }
    setFieldErr({});
    setError(null);
    setBusy(true);
    try {
      await login(parsed.data);
      nav(from.startsWith("/") ? from : "/overview", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  return (
    <AuthLayout title="Sign in" subtitle="Welcome back to your workspace.">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Field label="Email" name="email" type="email" autoComplete="email" required error={fieldErr.email} />
        <Field label="Password" name="password" type="password" autoComplete="current-password" required error={fieldErr.password} />
        <Button size="lg" className="w-full" disabled={busy}>{busy && <Spinner />}{busy ? "Signing in" : "Sign in"}</Button>
      </form>
      <p className="mt-6 text-sm text-muted-foreground">New here? <Link className="font-medium text-accent-foreground underline underline-offset-4" to="/register">Create a workspace</Link></p>
    </AuthLayout>
  );
}
