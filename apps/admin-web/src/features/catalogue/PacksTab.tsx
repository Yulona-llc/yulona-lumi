import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { errMsg } from "@/lib/errors";
import { ConfirmModal, Empty, ErrorState, Loading, Modal, TextField } from "@/components/common";
import { fmtNum, fmtPrice } from "@/lib/format";
import { adminApi } from "@/api/endpoints";
import { keys } from "@/api/keys";
import type { AdminPack } from "@/api/types";

function PackForm({ pack, onClose }: { pack: AdminPack | null; onClose: () => void }) {
  const [name, setName] = useState(pack?.name ?? "");
  const [credits, setCredits] = useState(pack ? String(pack.credits) : "");
  const [price, setPrice] = useState(pack ? String(pack.priceCents / 100) : "");
  const [order, setOrder] = useState(String(pack?.sortOrder ?? 0));
  const [active, setActive] = useState(pack?.active ?? true);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), credits: Number(credits), priceCents: Math.round(Number(price) * 100), active, sortOrder: Number(order) || 0 };
      return pack ? adminApi.updatePack(pack.id, body) : adminApi.createPack(body);
    },
    onSuccess: () => { toast.success(pack ? "Pack saved" : "Pack created"); onClose(); },
  });
  const ok = name.trim() && Number.isInteger(Number(credits)) && Number(credits) >= 1 && price !== "" && Number(price) >= 0;
  return (
    <Modal title={pack ? `Edit ${pack.name}` : "Add credit pack"} onClose={onClose}>
      <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (ok) save.mutate(); }}>
        {save.isError && <Alert variant="destructive">{errMsg(save.error)}</Alert>}
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Credits" inputMode="numeric" value={credits} onChange={(e) => setCredits(e.target.value)} required hint="Whole credits, 1 to 10,000,000." />
          <TextField label="Price (USD)" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required />
          <TextField label="Sort order" inputMode="numeric" value={order} onChange={(e) => setOrder(e.target.value)} hint="Lower numbers first; ties go to the cheapest." />
        </div>
        <label className="flex min-h-11 items-center gap-3 text-sm"><Switch checked={active} onCheckedChange={setActive} aria-label="Active" />Active (customers can buy it)</label>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={save.isPending || !ok}>{save.isPending && <Loader2 className="animate-spin" aria-hidden />}{pack ? "Save pack" : "Create pack"}</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function PacksTab() {
  const q = useQuery({ queryKey: keys.packs, queryFn: adminApi.packs });
  const [edit, setEdit] = useState<AdminPack | "new" | null>(null);
  const [del, setDel] = useState<AdminPack | null>(null);
  const rm = useMutation({ mutationFn: (p: AdminPack) => adminApi.deletePack(p.id), onSuccess: () => { setDel(null); toast.success("Pack deactivated"); }, onError: (e) => toast.error(errMsg(e)) });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground">Packs customers can buy on the Usage page. Deactivating keeps the pack for purchase history.</p>
        <Button onClick={() => setEdit("new")}><Plus aria-hidden />Add pack</Button>
      </div>
      {q.isPending ? <Loading label="Loading packs" /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} />
        : q.data.length === 0 ? <Empty title="No credit packs" body="Customers cannot top up until at least one active pack exists." action={<Button onClick={() => setEdit("new")}><Plus aria-hidden />Add pack</Button>} />
        : (
          <Card className="gap-0 p-0"><ul className="divide-y">
            {q.data.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1"><p className="flex items-center gap-2 font-medium">{p.name}{!p.active && <Badge variant="secondary">Inactive</Badge>}</p><p className="text-sm tabular-nums text-muted-foreground">{fmtNum(p.credits)} credits for {fmtPrice(p.priceCents, "usd")}</p></div>
                <div className="flex gap-1"><Button variant="outline" size="sm" onClick={() => setEdit(p)}><Pencil aria-hidden />Edit<span className="sr-only"> {p.name}</span></Button>
                  {p.active && <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => setDel(p)}><Trash2 aria-hidden /><span className="sr-only">Deactivate {p.name}</span></Button>}</div>
              </li>))}
          </ul></Card>
        )}
      {edit && <PackForm pack={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
      {del && <ConfirmModal danger title="Deactivate pack?" body={<><strong>{del.name}</strong> stops being offered. Past purchases are kept.</>} confirm="Deactivate pack" busy={rm.isPending} onConfirm={() => rm.mutate(del)} onClose={() => setDel(null)} />}
    </div>
  );
}
