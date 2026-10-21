import { Link } from "react-router";
import { cn } from "@/lib/utils";
import { fmtCredits, fmtNum, type GroupBy, type UsageRow } from "./api";

/**
 * Breakdown rows. One markup for every width: stacked cards on phones (each figure carries its own label),
 * a header row and aligned columns from `sm`. Credits are hidden in self-hosted mode.
 */
export function Breakdown({ rows, groupBy, credits, nameLabel }: { rows: UsageRow[]; groupBy: GroupBy; credits: boolean; nameLabel: string }) {
  const cols = credits ? "sm:grid-cols-[minmax(0,1fr)_repeat(4,6.5rem)]" : "sm:grid-cols-[minmax(0,1fr)_repeat(3,6.5rem)]";
  const maxCredits = Math.max(1, ...rows.map((r) => r.creditsMicro));
  const maxTokens = Math.max(1, ...rows.map((r) => r.totalTokens));
  return (
    <div role="table" aria-label={`Usage ${nameLabel}`} className="min-w-0">
      <div role="row" className={cn("hidden gap-3 border-b px-3 pb-2 text-sm text-muted-foreground sm:grid", cols)}>
        <span role="columnheader">{nameLabel}</span>
        {credits && <span role="columnheader" className="text-right">Credits</span>}
        <span role="columnheader" className="text-right">Requests</span>
        <span role="columnheader" className="text-right">Input tokens</span>
        <span role="columnheader" className="text-right">Output tokens</span>
      </div>
      <ul className="divide-y max-sm:space-y-2 max-sm:divide-y-0">
        {rows.map((r) => {
          const share = credits ? r.creditsMicro / maxCredits : r.totalTokens / maxTokens;
          const name = groupBy === "conversation" ? <Link to={`/inbox/${r.key}`} className="font-medium underline-offset-4 hover:underline">Conversation <span className="font-mono text-sm">{r.key.slice(0, 8)}</span></Link> : <span className="font-medium">{r.label}</span>;
          return (
            <li key={r.key} role="row" className={cn("relative grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-3 max-sm:rounded-xl max-sm:border max-sm:bg-card sm:items-center", cols)}>
              <span role="cell" className="col-span-2 min-w-0 truncate sm:col-span-1">{name}
                <span aria-hidden className="mt-1.5 block h-1 rounded-full bg-muted"><span className="block h-1 rounded-full bg-primary" style={{ width: `${Math.max(2, share * 100)}%` }} /></span></span>
              {credits && <Cell label="Credits" value={fmtCredits(r.creditsMicro)} strong />}
              <Cell label="Requests" value={fmtNum(r.requests)} />
              <Cell label="Input" value={fmtNum(r.promptTokens)} />
              <Cell label="Output" value={fmtNum(r.completionTokens)} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Cell({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <span role="cell" className="flex items-baseline justify-between gap-2 text-sm tabular-nums sm:block sm:text-right">
      <span className="text-muted-foreground sm:sr-only">{label}</span>
      <span className={strong ? "font-medium" : undefined}>{value}</span>
    </span>
  );
}
