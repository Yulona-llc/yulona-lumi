import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "@/components/ui/sonner";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { useAuth } from "@/auth/AuthProvider";
import { whoCan } from "@/auth/permissions";
import { Badge } from "@/components/ui/badge";
import { Gated, Section } from "@/components/bits";
import { Empty, ErrorState, Loading } from "@/components/common";
import { errMsg } from "@/lib/errors";

const opts = [["default", "Default"], ["on", "On"], ["off", "Off"]] as const;

export default function FlagsTab({ id }: { id: string }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: keys.tenantFlags(id), queryFn: () => adminApi.tenantFlags(id) });
  const set = useMutation({ mutationFn: ({ key, v }: { key: string; v: boolean | null }) => adminApi.setTenantFlag(id, key, v), onError: (e) => toast.error(errMsg(e)) });
  if (q.isPending) return <Loading rows={3} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (q.data.items.length === 0) return <Empty title="No feature flags" body="Create flags on the Feature flags page, then override them per customer here." />;
  return (
    <Section title="Feature flags for this customer" hint="An override beats the platform default. Only owners can change them.">
      <ul className="-my-2 divide-y">
        {q.data.items.map((f) => {
          const cur = f.override === null ? "default" : f.override ? "on" : "off";
          return (
            <li key={f.key} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1"><p className="font-mono text-sm">{f.key}</p><p className="text-xs text-muted-foreground">Default {f.defaultEnabled ? "on" : "off"}</p></div>
              <Badge variant={f.effective ? "success" : "secondary"}>{f.effective ? "Effective: on" : "Effective: off"}</Badge>
              <Gated allowed={can("tenantFlags")} reason={whoCan("tenantFlags")}>
                <div role="radiogroup" aria-label={`Override for ${f.key}`} className="inline-flex rounded-lg border p-0.5">
                  {opts.map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={cur === v} disabled={!can("tenantFlags") || set.isPending} onClick={() => set.mutate({ key: f.key, v: v === "default" ? null : v === "on" })}
                    className={`min-h-8 rounded-md px-3 text-xs font-medium disabled:cursor-not-allowed ${cur === v ? "bg-primary/15 text-accent-foreground" : "text-muted-foreground hover:text-foreground"}`}>{l}</button>)}
                </div>
              </Gated>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
