import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { Section } from "@/components/bits";
import { ErrorState, Loading } from "@/components/common";
import { fmtDate } from "@/lib/format";

export default function AuditTab({ id }: { id: string }) {
  const audit = useQuery({ queryKey: keys.audit({ tenantId: id, limit: 30 }), queryFn: () => adminApi.audit({ tenantId: id, limit: 30 }) });
  const imp = useQuery({ queryKey: keys.impersonations(id), queryFn: () => adminApi.impersonations(id, 10) });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title="Admin actions on this customer" hint="Views, exports and every change made from this console">
        {audit.isPending ? <Loading rows={3} /> : audit.isError ? <ErrorState error={audit.error} retry={() => void audit.refetch()} /> : audit.data.items.length === 0 ? <p className="text-sm text-muted-foreground">No admin has acted on this customer yet.</p> : (
          <ul className="-my-2 divide-y">{audit.data.items.map((a) => <li key={a.id} className="py-2.5"><p className="font-mono text-xs">{a.action}</p><p className="text-xs text-muted-foreground">{a.adminEmail ?? "system"} · {fmtDate(a.createdAt)}</p></li>)}</ul>
        )}
      </Section>
      <Section title="Impersonation history">
        {imp.isPending ? <Loading rows={2} /> : imp.isError ? <ErrorState error={imp.error} retry={() => void imp.refetch()} /> : imp.data.items.length === 0 ? <p className="text-sm text-muted-foreground">Nobody has impersonated this customer.</p> : (
          <ul className="-my-2 divide-y">{imp.data.items.map((r) => (
            <li key={r.id} className="py-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{r.adminEmail}</span><Badge variant={r.readOnly ? "info" : "warning"}>{r.readOnly ? "Read-only" : "Write mode"}</Badge></div>
              <p className="mt-0.5 break-words text-muted-foreground">{r.reason}</p>
              <p className="text-xs text-muted-foreground">{fmtDate(r.startedAt)}{r.endedAt ? `, ended ${fmtDate(r.endedAt)}` : r.exchangedAt ? "" : ", never opened"}</p>
            </li>))}</ul>
        )}
      </Section>
    </div>
  );
}
