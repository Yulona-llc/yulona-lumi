import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import { Section, StatusBadge } from "@/components/bits";
import { ErrorState, Loading } from "@/components/common";
import { ago, titleCase } from "@/lib/format";

function Row({ title, sub, right, error }: { title: string; sub?: ReactNode; right?: ReactNode; error?: string | null }) {
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 py-2.5 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{title}</p>{sub && <p className="text-xs text-muted-foreground">{sub}</p>}
        {error && <p className="mt-1 flex items-start gap-1.5 break-words text-xs text-destructive"><AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden />{error}</p>}</div>
      {right}
    </li>
  );
}
const Empty = ({ what }: { what: string }) => <p className="text-sm text-muted-foreground">No {what}.</p>;

export default function SetupTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: keys.assets(id), queryFn: () => adminApi.assets(id) });
  if (q.isPending) return <Loading rows={4} />;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const a = q.data;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section title={`Agents (${a.agents.length})`}>
        {a.agents.length === 0 ? <Empty what="agents" /> : <ul className="divide-y">{a.agents.map((x) => <Row key={x.id} title={x.name} sub={`${x.publishedVersion ? `Published v${x.publishedVersion}` : "Never published"} · updated ${ago(x.updatedAt)}`} right={<StatusBadge status={x.status} />} />)}</ul>}
      </Section>
      <Section title={`Widgets (${a.widgets.length})`}>
        {a.widgets.length === 0 ? <Empty what="widgets" /> : <ul className="divide-y">{a.widgets.map((x) => <Row key={x.id} title={x.name} sub={x.domains.length ? x.domains.join(", ") : "No allowed domains"} right={<Badge variant={x.enabled ? "success" : "secondary"}>{x.enabled ? "Enabled" : "Off"}</Badge>} />)}</ul>}
      </Section>
      <Section title={`Channels (${a.channels.length})`}>
        {a.channels.length === 0 ? <Empty what="channels" /> : <ul className="divide-y">{a.channels.map((x) => <Row key={x.id} title={`${x.name} (${titleCase(x.channel)})`} sub={x.lastHealthAt ? `Checked ${ago(x.lastHealthAt)}` : "Never checked"} error={x.lastHealthOk === false ? x.lastHealthError ?? "Last health check failed" : null}
          right={x.lastHealthOk === false ? <Badge variant="destructive">Failing</Badge> : x.lastHealthOk ? <Badge variant="success"><CheckCircle2 aria-hidden />Healthy</Badge> : <StatusBadge status={x.status} />} />)}</ul>}
      </Section>
      <Section title={`Knowledge (${a.knowledge.length})`}>
        {a.knowledge.length === 0 ? <Empty what="knowledge sources" /> : <ul className="divide-y">{a.knowledge.map((x) => <Row key={x.id} title={x.name} sub={`${titleCase(x.type)} · ${x.chunkCount} chunks · ${x.lastIngestedAt ? `ingested ${ago(x.lastIngestedAt)}` : "not ingested"}`} error={x.error} right={<StatusBadge status={x.status} />} />)}</ul>}
      </Section>
      <Section title={`Webhooks (${a.webhooks.length})`}>
        {a.webhooks.length === 0 ? <Empty what="webhooks" /> : <ul className="divide-y">{a.webhooks.map((x) => <Row key={x.id} title={x.name} sub={`${x.host ?? "no host"} · last success ${ago(x.lastSuccessAt)}`}
          error={x.disabledReason ?? (x.consecutiveFailures > 0 ? `${x.consecutiveFailures} failures in a row, last ${ago(x.lastFailureAt)}` : null)} right={<Badge variant={x.enabled ? "success" : "destructive"}>{x.enabled ? "Enabled" : "Disabled"}</Badge>} />)}</ul>}
      </Section>
      <Section title={`Connections (${a.connections.length})`} hint="Tool connections. Credentials are never shown.">
        {a.connections.length === 0 ? <Empty what="connections" /> : <ul className="divide-y">{a.connections.map((x) => <Row key={x.id} title={x.name} sub={`${titleCase(x.kind)} · ${titleCase(x.authType)} · ${x.host ?? "no host"}`} />)}</ul>}
      </Section>
      <Section title="Calendar and CRM">
        {a.calendar.length + a.crm.length === 0 ? <Empty what="calendar or CRM integrations" /> : (
          <ul className="divide-y">
            {a.calendar.map((x) => <Row key={`c-${x.provider}`} title={`${titleCase(x.provider)} calendar`} error={x.lastError} right={<StatusBadge status={x.status} />} />)}
            {a.crm.map((x) => <Row key={`m-${x.provider}`} title={`${titleCase(x.provider)} CRM`} sub={x.lastSyncAt ? `Last sync ${ago(x.lastSyncAt)}` : "Never synced"} error={x.lastError} right={<StatusBadge status={x.status} />} />)}
          </ul>
        )}
      </Section>
    </div>
  );
}
