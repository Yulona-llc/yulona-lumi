import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { errMsg } from "../common/api";
import { ErrorState, Modal } from "../common/ui";
import { creditKeys, creditsApi, fmtNum, fmtPrice } from "./api";

/** Credit packs as a radio group; "Buy credits" sends the browser to the provider checkout. */
export function BuyCreditsDialog({ onClose }: { onClose: () => void }) {
  const packs = useQuery({ queryKey: creditKeys.packs, queryFn: creditsApi.packs });
  const [picked, setPicked] = useState<string | null>(null);
  const buy = useMutation({
    mutationFn: (id: string) => creditsApi.checkout(id),
    onSuccess: (r) => { toast.success("Redirecting to payment"); window.location.assign(r.url); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const items = packs.data ?? [];
  const sel = picked ?? (items.length ? items[Math.min(1, items.length - 1)]!.id : null);
  return (
    <Modal title="Buy credits" description="Credits never expire. They are used after your monthly allowance runs out." onClose={onClose}>
      {packs.isPending ? <div role="status" className="space-y-2"><span className="sr-only">Loading credit packs…</span>{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>
        : packs.isError ? <ErrorState error={packs.error} retry={() => void packs.refetch()} />
        : items.length === 0 ? <p className="py-4 text-sm text-muted-foreground">No credit packs are available right now. Contact support to add credits.</p>
        : (
          <div className="space-y-4">
            <div role="radiogroup" aria-label="Credit packs" className="grid gap-2">
              {items.map((p) => {
                const on = sel === p.id;
                return (
                  <button key={p.id} type="button" role="radio" aria-checked={on} onClick={() => setPicked(p.id)}
                    className={cn("flex min-h-16 items-center gap-3 rounded-xl border px-4 py-3 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40", on ? "border-primary bg-accent" : "hover:bg-muted/60")}>
                    <span className={cn("grid size-5 shrink-0 place-items-center rounded-full border", on ? "border-primary bg-primary text-primary-foreground" : "border-input")}>{on && <Check className="size-3" aria-hidden />}</span>
                    <span className="min-w-0 flex-1"><span className="block font-medium">{p.name}</span><span className="block text-sm tabular-nums text-muted-foreground">{fmtNum(p.credits)} credits</span></span>
                    <span className="font-display text-lg font-semibold tabular-nums">{fmtPrice(p.priceCents, p.currency)}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={onClose}>Cancel</Button>
              <Button disabled={!sel || buy.isPending} onClick={() => sel && buy.mutate(sel)}>{buy.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}Buy credits</Button>
            </div>
          </div>
        )}
    </Modal>
  );
}
