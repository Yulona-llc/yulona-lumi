import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldAlert } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { ag, errMsg, type ApiKeyRow } from "../common/api";
import { API_KEY_SCOPES } from "../integrations-ui/scopes";
import { ScopePicker } from "../integrations-ui/ScopePicker";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "@/components/ui/sonner";
import { Spinner } from "../../components/ui";
import { Badge, Check, ConfirmModal, Empty, ErrorState, fmtDate, Loading, Modal, PageHeader, RoleNotice, TextField, useRole } from "../common/ui";
import { CopyButton } from "./parts";
import { apiBase } from "../../config";

const SCOPES = API_KEY_SCOPES;
const COLS = "lg:grid-cols-[minmax(0,1.1fr)_7rem_minmax(0,1.4fr)_5.5rem_8rem_5.5rem]";

export default function ApiKeysPage() {
  const { isAdmin } = useRole();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["api-keys"], queryFn: ag.apiKeys, enabled: isAdmin });
  const [create, setCreate] = useState(false);
  const [secret, setSecret] = useState<ApiKeyRow | null>(null);
  const [revoke, setRevoke] = useState<ApiKeyRow | null>(null);
  const inv = () => void qc.invalidateQueries({ queryKey: ["api-keys"] });
  const rv = useMutation({
    mutationFn: (k: ApiKeyRow) => ag.revokeApiKey(k.id),
    onSuccess: (_d, k) => { setRevoke(null); toast.success(`Revoked ${k.name}`); inv(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (!isAdmin) return <><PageHeader title="API keys" /><RoleNotice what="managing API keys" /></>;
  return (
    <div>
      <PageHeader title="API keys" subtitle="Keys authenticate server-to-server calls to the public API. A key is shown once, at creation." actions={<Button onClick={() => setCreate(true)}><Plus />Create key</Button>} />
      {q.isPending ? <Loading /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : q.data.length === 0 ? <Empty title="No API keys" body="Create a key to integrate Lumi with your own systems." action={<Button onClick={() => setCreate(true)}>Create your first key</Button>} /> : (
        <div className="overflow-hidden rounded-2xl border bg-card">
          <div className={`hidden gap-4 border-b bg-muted/50 px-4 py-2.5 text-xs font-medium text-muted-foreground lg:grid ${COLS}`} aria-hidden>
            <span>Name</span><span>Prefix</span><span>Scopes</span><span>Limit</span><span>Expires</span><span />
          </div>
          <ul className="divide-y">
            <AnimatePresence initial={false}>
              {q.data.map((k) => (
                <motion.li key={k.id} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className={`grid items-center gap-x-4 gap-y-1.5 px-4 py-3.5 lg:py-3 ${COLS}`}>
                  <p className="flex min-w-0 items-center gap-2 font-medium"><span className="truncate">{k.name}</span>{k.revokedAt && <Badge color="red">revoked</Badge>}</p>
                  <p className="font-mono text-xs text-muted-foreground">{k.prefix}…</p>
                  <p className="text-xs text-muted-foreground">{k.scopes.length ? k.scopes.map((s) => <span key={s} className="mr-1 mb-1 inline-block rounded-md bg-muted px-1.5 py-0.5 font-mono">{s}</span>) : "No scopes"}</p>
                  <p className="text-sm tabular-nums text-muted-foreground"><span className="lg:hidden">Limit: </span>{k.rateLimitPerMinute}/min</p>
                  <p className="text-sm text-muted-foreground"><span className="lg:hidden">Expires: </span>{k.expiresAt ? fmtDate(k.expiresAt) : "Never"}</p>
                  <div className="lg:text-right">{!k.revokedAt && <Button variant="outline" size="sm" className="text-destructive" onClick={() => setRevoke(k)}>Revoke<span className="sr-only"> {k.name}</span></Button>}</div>
                </motion.li>))}
            </AnimatePresence>
          </ul>
        </div>)}
      {create && <CreateKey onClose={() => setCreate(false)} onDone={(k) => { setCreate(false); setSecret(k); inv(); }} />}
      {secret && (
        <Modal title="Copy your new key" description="Store it in a secret manager now." onClose={() => setSecret(null)}>
          <Alert variant="warning" className="mb-3"><ShieldAlert /><AlertTitle>This is the only time the full key is shown</AlertTitle><AlertDescription>After you close this, only the prefix is visible.</AlertDescription></Alert>
          <code className="block break-all rounded-xl border bg-muted p-3 font-mono text-sm" data-testid="new-key">{secret.key}</code>
          <div className="mt-4">
            <p className="text-sm font-medium">Test it now</p>
            <p className="mb-1.5 text-sm text-muted-foreground">Run this in a terminal. A reply with your key's scopes means it works; a 401 means it was copied wrongly.</p>
            <code className="block break-all rounded-xl border bg-muted p-3 font-mono text-xs" data-testid="key-test-command">{`curl -H "Authorization: Bearer ${secret.key}" ${apiBase()}/key-info`}</code>
            <div className="mt-2"><CopyButton text={`curl -H "Authorization: Bearer ${secret.key}" ${apiBase()}/key-info`} what="Command copied" size="default" /></div>
          </div>
          <div className="mt-5 flex justify-end gap-2"><CopyButton text={secret.key ?? ""} what="Key copied" size="default" /><Button onClick={() => setSecret(null)}>Done</Button></div>
        </Modal>)}
      {revoke && <ConfirmModal danger title="Revoke this key?" body={<>Anything using "{revoke.name}" stops working immediately.</>} confirm="Revoke" busy={rv.isPending} onConfirm={() => rv.mutate(revoke)} onClose={() => setRevoke(null)} />}
    </div>
  );
}

function CreateKey({ onClose, onDone }: { onClose: () => void; onDone: (k: ApiKeyRow) => void }) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["conversations:read"]);
  const [rate, setRate] = useState(60);
  const m = useMutation({
    mutationFn: () => ag.createApiKey({ name: name.trim(), scopes, rateLimitPerMinute: rate }),
    onSuccess: (k) => { toast.success("Key created"); onDone(k); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Modal title="Create API key" onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (name.trim()) m.mutate(); }}>
        <TextField label="Name" hint="What will use this key, for example CRM sync." value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} />
        <fieldset><legend className="mb-2 text-sm font-medium">Scopes</legend><ScopePicker value={scopes} onChange={setScopes} /></fieldset>
        <TextField label="Requests per minute" type="number" min={1} max={10000} value={rate} onChange={(e) => setRate(Math.max(1, Number(e.target.value) || 1))} />
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={m.isPending || !name.trim()}>{m.isPending && <Spinner />}Create</Button></div>
      </form>
    </Modal>
  );
}
