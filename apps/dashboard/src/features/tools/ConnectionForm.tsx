import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, Eye, EyeOff, KeyRound, Lock, Sparkles, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Spinner } from "../../components/ui";
import { errMsg } from "../common/api";
import { Select, TextField } from "../common/ui";
import { tl, rememberConnectionTest, type AuthType, type Connection, type ConnectionInput, type ConnectionTest } from "./api";
import { AUTH_HELP, AUTH_LABEL, explainError } from "./model";

/** Result of a connection test: status, speed and (when it failed) what to fix. The request shown is already redacted by the server. */
export function ConnectionTestResult({ result }: { result: ConnectionTest }) {
  return result.ok ? (
    <Alert variant="success" role="status"><CheckCircle2 /><AlertTitle>Your system answered</AlertTitle>
      <AlertDescription>Status {result.status} in {result.latencyMs} ms.{result.excerpt ? <code className="mt-1.5 block max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted px-2 py-1 font-mono text-xs">{result.excerpt}</code> : null}</AlertDescription></Alert>
  ) : (
    <Alert variant="destructive"><TriangleAlert /><AlertTitle>The test did not work</AlertTitle>
      <AlertDescription>{explainError(result.error)}{result.request ? <code className="mt-1.5 block break-all font-mono text-xs">{result.request.method} {result.request.url}</code> : null}</AlertDescription></Alert>
  );
}

function randomSecret() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/**
 * Create or edit a connection. The secret is write-only: after saving, the form only knows `hasSecret`
 * and shows a masked state with a Replace button; it never holds the old value.
 */
export function ConnectionForm({ initial, onDone, onCancel }: { initial?: Connection; onDone: (c: Connection) => void; onCancel?: () => void }) {
  const edit = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "https://");
  const [authType, setAuthType] = useState<AuthType>(initial?.authType ?? "bearer");
  const [header, setHeader] = useState(initial?.authHeaderName ?? "X-API-Key");
  const [secret, setSecret] = useState("");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [testPath, setTestPath] = useState(initial?.testPath ?? "");
  const [replacing, setReplacing] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [err, setErr] = useState<string>();
  const [saved, setSaved] = useState<{ conn: Connection; test?: ConnectionTest }>();
  const masked = edit && initial.hasSecret && initial.authType === authType && !replacing && authType !== "none";
  const needsSecret = authType !== "none" && !masked;
  const secretValue = authType === "basic" ? (user || pass ? `${user}:${pass}` : "") : secret;

  const save = useMutation({
    mutationFn: async (andTest: boolean) => {
      const common = { name: name.trim(), baseUrl: baseUrl.trim(), authType, ...(authType === "api_key" ? { authHeaderName: header.trim() || "X-API-Key" } : {}) };
      const conn = edit
        ? await tl.updateConnection(initial.id, { ...common, ...(needsSecret && secretValue ? { secret: secretValue } : {}), ...(authType === "none" && initial.hasSecret ? { secret: null } : {}), testPath: testPath.trim() || null })
        : await tl.createConnection({ ...common, ...(needsSecret ? { secret: secretValue } : {}), ...(testPath.trim() ? { testPath: testPath.trim() } : {}) } satisfies ConnectionInput);
      let test: ConnectionTest | undefined;
      if (andTest) { test = await tl.testConnection(conn.id); rememberConnectionTest(conn.id, test); }
      return { conn, test };
    },
    onSuccess: ({ conn, test }, andTest) => {
      toast.success(edit ? "Connection saved" : "Connection saved", test ? { description: test.ok ? `Your system answered (${test.status}).` : "The test did not work. See the result." } : undefined);
      setErr(undefined);
      if (andTest) setSaved({ conn, test }); else onDone(conn);
    },
    onError: (e) => setErr(errMsg(e)),
  });

  const invalid = !name.trim() || !/^https?:\/\/.+\..+|^https?:\/\/localhost/.test(baseUrl.trim()) || (needsSecret && !secretValue.trim()) || (authType === "basic" && needsSecret && !(user && pass));
  const testNow = useMutation({
    meta: { skipInvalidate: true },
    mutationFn: async () => { const t = await tl.testConnection(initial!.id, testPath.trim() || undefined); rememberConnectionTest(initial!.id, t); return t; },
    onSuccess: (t) => { setSaved({ conn: initial!, test: t }); toast[t.ok ? "success" : "error"](t.ok ? "Your system answered" : "The test did not work"); },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (saved) {
    return (
      <div className="space-y-4">
        {saved.test && <ConnectionTestResult result={saved.test} />}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {edit && <Button variant="outline" onClick={() => setSaved(undefined)}>Edit again</Button>}
          <Button onClick={() => onDone(saved.conn)}>{edit ? "Done" : "Use this connection"}</Button>
        </div>
      </div>
    );
  }

  return (
    <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (!invalid) save.mutate(false); }} aria-label={edit ? "Edit connection" : "New connection"}>
      <TextField label="Connection name" hint="Anything you will recognise, such as Orders system." value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoComplete="off" />
      <TextField label="Web address of your system" hint="Start with https://. This is the address the AI calls, without the page part. Self-hosted installs also accept http://." value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} inputMode="url" autoComplete="off" spellCheck={false} className="font-mono text-sm" />
      <div className="space-y-1.5">
        <Select label="How does your system sign requests in?" value={authType} onChange={(e) => { setAuthType(e.target.value as AuthType); setReplacing(false); }}>
          {(Object.keys(AUTH_LABEL) as AuthType[]).map((a) => <option key={a} value={a}>{AUTH_LABEL[a]}</option>)}
        </Select>
        <p className="text-sm text-muted-foreground">{AUTH_HELP[authType]}</p>
      </div>
      {authType === "api_key" && <TextField label="Header name" hint="The header that carries the key." value={header} onChange={(e) => setHeader(e.target.value)} className="font-mono text-sm" spellCheck={false} />}
      {masked && (
        <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/50 px-3 py-2.5">
          <p className="flex min-w-0 items-center gap-2 text-sm"><Lock className="size-4 shrink-0 text-muted-foreground" /><span className="font-mono tracking-widest" aria-hidden>{"•".repeat(12)}</span><span className="text-muted-foreground">Secret saved. It is never shown again.</span></p>
          <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}><KeyRound />Replace secret</Button>
        </div>
      )}
      {needsSecret && authType === "basic" && (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Username" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" />
          <TextField label="Password" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
        </div>
      )}
      {needsSecret && authType !== "basic" && (
        <div className="space-y-1.5">
          <TextField label={authType === "hmac" ? "Signing secret" : authType === "api_key" ? "API key" : "Token"} hint={edit ? "Saving replaces the stored secret. We cannot show it afterwards." : "We store it encrypted and never show it again."}
            type={reveal ? "text" : "password"} value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" spellCheck={false} className="font-mono text-sm" />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setReveal((v) => !v)} aria-pressed={reveal}>{reveal ? <EyeOff /> : <Eye />}{reveal ? "Hide" : "Show"} what I typed</Button>
            {authType === "hmac" && <Button type="button" variant="ghost" size="sm" onClick={() => { setSecret(randomSecret()); setReveal(true); }}><Sparkles />Generate one</Button>}
            {replacing && <Button type="button" variant="ghost" size="sm" onClick={() => { setReplacing(false); setSecret(""); }}>Keep the saved secret</Button>}
          </div>
        </div>
      )}
      <TextField label="Page to test with (optional)" hint="A harmless page such as /health. Used by Test connection." value={testPath} onChange={(e) => setTestPath(e.target.value)} placeholder="/health" className="font-mono text-sm" spellCheck={false} />
      {err && <Alert variant="destructive"><TriangleAlert /><AlertDescription>{err}</AlertDescription></Alert>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
        {edit
          ? <Button type="button" variant="outline" disabled={testNow.isPending || save.isPending} onClick={() => testNow.mutate()}>{testNow.isPending && <Spinner />}Test connection</Button>
          : <Button type="button" variant="outline" disabled={invalid || save.isPending} onClick={() => save.mutate(true)}>{save.isPending && save.variables === true && <Spinner />}Save and test</Button>}
        <Button type="submit" disabled={invalid || save.isPending}>{save.isPending && save.variables === false && <Spinner />}Save connection</Button>
      </div>
    </form>
  );
}
