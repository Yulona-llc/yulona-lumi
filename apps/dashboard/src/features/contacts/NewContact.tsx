import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Modal, TextField } from "../common/ui";
import { contactsApi } from "./api";
import { ApiError } from "../../api/client";

export default function NewContact({ onClose }: { onClose: () => void }) {
  const [v, setV] = useState({ name: "", email: "", phone: "" });
  const qc = useQueryClient();
  const nav = useNavigate();
  const m = useMutation({
    mutationFn: () => contactsApi.create(Object.fromEntries(Object.entries(v).filter(([, x]) => x.trim()))),
    onSuccess: (c) => { void qc.invalidateQueries({ queryKey: ["contacts"] }); toast.success("Contact created"); nav(`/contacts/${c.id}`); },
  });
  const empty = !v.name.trim() && !v.email.trim() && !v.phone.trim();
  return (
    <Modal title="New contact" description="Add someone by hand. Chat contacts are created for you." onClose={onClose}>
      <form className="space-y-3" aria-label="New contact" onSubmit={(e) => { e.preventDefault(); if (!empty) m.mutate(); }}>
        {m.error && <Alert variant="destructive">{m.error instanceof ApiError ? m.error.message : "Could not create contact."}</Alert>}
        <TextField label="Name" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        <TextField label="Email" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
        <TextField label="Phone" type="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} hint="Provide at least one field." />
        <div className="flex justify-end gap-2 pt-1"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button><Button disabled={empty || m.isPending}>{m.isPending ? "Creating…" : "Create contact"}</Button></div>
      </form>
    </Modal>
  );
}
