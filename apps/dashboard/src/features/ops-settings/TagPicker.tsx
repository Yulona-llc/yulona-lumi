import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Tag as TagIcon, X } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { errMsg } from "../common/api";
import { useRole } from "../common/ui";
import { ops, type Tag } from "./opsApi";

export type TagResource = "conversations" | "contacts" | "tickets";

/**
 * The tags on one conversation, contact or ticket, as removable chips, with a menu to add more from the workspace's tags
 * (manage the list under Settings, then Tags). Agents and above can change them; viewers only see them.
 */
export default function TagPicker({ resource, id, className }: { resource: TagResource; id: string; className?: string }) {
  const { atLeast } = useRole();
  const canEdit = atLeast("agent");
  const qc = useQueryClient();
  const key = ["resource-tags", resource, id];
  const mine = useQuery({ queryKey: key, queryFn: () => ops.resourceTags(resource, id) });
  const all = useQuery({ queryKey: ["tags"], queryFn: ops.tags, staleTime: 60_000 });
  const [open, setOpen] = useState(false);
  const set = useMutation({
    mutationFn: (ids: string[]) => ops.setResourceTags(resource, id, ids),
    onSuccess: (r) => { qc.setQueryData(key, r.items); void qc.invalidateQueries({ queryKey: ["tickets"] }); },
    onError: (e) => toast.error("Could not update tags", { description: errMsg(e) }),
  });
  const current: Tag[] = mine.data ?? [];
  const has = (t: Tag) => current.some((c) => c.id === t.id);
  const toggle = (t: Tag) => set.mutate((has(t) ? current.filter((c) => c.id !== t.id) : [...current, t]).map((x) => x.id));
  const options = all.data ?? [];

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)} aria-label="Tags">
      {current.map((t) => (
        <span key={t.id} className="inline-flex items-center gap-1.5 rounded-full border bg-secondary py-0.5 pl-2.5 pr-1.5 text-xs font-medium">
          <span aria-hidden="true" className="size-2 rounded-full" style={{ background: t.color }} />{t.name}
          {canEdit && <button type="button" aria-label={`Remove tag ${t.name}`} disabled={set.isPending} className="grid size-4 place-items-center rounded-full hover:bg-foreground/10" onClick={() => toggle(t)}><X className="size-3" /></button>}
        </span>
      ))}
      {current.length === 0 && !canEdit && <span className="text-xs text-muted-foreground">No tags</span>}
      {canEdit && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild><Button type="button" variant="outline" size="sm" className="h-7 gap-1 rounded-full px-2.5 text-xs"><Plus className="size-3" />{current.length ? "Tag" : "Add tag"}</Button></PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-1.5">
            {options.length === 0
              ? <p className="flex items-start gap-2 p-2 text-sm text-muted-foreground"><TagIcon className="mt-0.5 size-4 shrink-0" />No tags yet. Create some under Settings, then Tags.</p>
              : <ul className="max-h-64 overflow-y-auto" aria-label="Workspace tags">{options.map((t) => (
                  <li key={t.id}>
                    <button type="button" role="checkbox" aria-checked={has(t)} disabled={set.isPending} onClick={() => toggle(t)} className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-accent">
                      <span aria-hidden="true" className="size-2.5 rounded-full" style={{ background: t.color }} /><span className="flex-1 truncate">{t.name}</span>{has(t) && <Check className="size-4 text-primary" />}
                    </button>
                  </li>))}</ul>}
          </PopoverContent>
        </Popover>)}
    </div>
  );
}
