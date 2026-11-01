import { type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, type InputHTMLAttributes, useId } from "react";
import { AlertTriangle, Inbox as InboxIcon } from "lucide-react";
import { Badge as BadgeBase } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card as CardBase } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { AnimatedNumber } from "@/components/motion";
import { cn } from "@/lib/utils";

/** Page title block. Stacks on phones (actions below, full width), sits on one row from `sm`. */
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-semibold tracking-tight sm:text-[1.7rem]">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-[0.9375rem] text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2 max-sm:[&>*]:flex-1">{actions}</div>}
    </div>
  );
}

/** Skeleton-first loading state (keeps layout stable); `label` stays available to screen readers. */
export function Loading({ label = "Loading", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div role="status" aria-live="polite" className="space-y-3 py-4">
      <span className="sr-only">{label}…</span>
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-16 w-full" style={{ opacity: 1 - i * 0.18 }} />)}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : "Something went wrong";
  return (
    <div role="alert" className="flex gap-3 rounded-xl border border-destructive/35 bg-destructive/8 p-4">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
      <div className="min-w-0">
        <p className="font-medium">Could not load this</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{msg}</p>
        {retry && <Button variant="outline" size="sm" className="mt-3" onClick={retry}>Try again</Button>}
      </div>
    </div>
  );
}

export function Empty({ title, body, action, icon }: { title: string; body: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed bg-card/60 px-6 py-12 text-center">
      <span className="mb-4 grid size-12 place-items-center rounded-2xl bg-accent text-accent-foreground">{icon ?? <InboxIcon className="size-6" />}</span>
      <p className="font-display text-lg font-semibold">{title}</p>
      <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <CardBase className={className}>{children}</CardBase>;
}

const toneVariant = { green: "success", amber: "warning", red: "destructive", blue: "info", gray: "secondary" } as const;
/** Status chip. `color` keeps the names older pages use. */
export function Badge({ children, color = "gray" }: { children: ReactNode; color?: keyof typeof toneVariant }) {
  return <BadgeBase variant={toneVariant[color]}>{children}</BadgeBase>;
}

/** Number tile: the value counts up the first time it is seen. */
export function Stat({ label, value, hint, format, className }: { label: string; value: number; hint?: ReactNode; format?: (n: number) => string; className?: string }) {
  return (
    <CardBase className={cn("gap-1.5", className)}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="font-display text-3xl font-semibold tabular-nums tracking-tight"><AnimatedNumber value={value} format={format} /></p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </CardBase>
  );
}

type Common = { label: string; hint?: string; error?: string };
function Wrap({ id, label, hint, error, children }: Common & { id: string; children: ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {(error || hint) && <p id={`${id}-d`} className={cn("text-sm", error ? "text-destructive" : "text-muted-foreground")}>{error ?? hint}</p>}
    </div>
  );
}
export function TextField({ label, hint, error, ...p }: InputHTMLAttributes<HTMLInputElement> & Common) {
  const id = useId();
  return <Wrap id={id} label={label} hint={hint} error={error}><Input id={id} aria-invalid={error ? true : undefined} aria-describedby={error || hint ? `${id}-d` : undefined} {...p} /></Wrap>;
}
export function TextArea({ label, hint, error, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement> & Common) {
  const id = useId();
  return <Wrap id={id} label={label} hint={hint} error={error}><Textarea id={id} aria-invalid={error ? true : undefined} aria-describedby={error || hint ? `${id}-d` : undefined} {...p} /></Wrap>;
}
/** Native select (best on phones: the OS picker) styled to match the Input. */
export function Select({ label, hint, error, children, className, ...p }: SelectHTMLAttributes<HTMLSelectElement> & Common) {
  const id = useId();
  return (
    <Wrap id={id} label={label} hint={hint} error={error}>
      <select id={id} className={cn("field appearance-none bg-[length:1rem] bg-[right_0.75rem_center] bg-no-repeat pr-9", className)} style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2354657f' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }} aria-describedby={error || hint ? `${id}-d` : undefined} {...p}>{children}</select>
    </Wrap>
  );
}
export function Check({ label, className, checked, defaultChecked, onChange, disabled, name, value, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode }) {
  const id = useId();
  void rest;
  return (
    <label htmlFor={id} className={cn("flex min-h-11 cursor-pointer items-center gap-3 text-[0.9375rem] sm:min-h-9", disabled && "cursor-not-allowed opacity-60", className)}>
      <Checkbox
        id={id} name={name} value={value as string | undefined} disabled={disabled} checked={checked} defaultChecked={defaultChecked}
        onCheckedChange={(v) => onChange?.({ target: { checked: v === true, name, value }, currentTarget: { checked: v === true, name, value } } as never)}
      />
      {label}
    </label>
  );
}

/**
 * Dialog on tablets and desktops, bottom sheet on phones. API unchanged: render it while it should be open.
 * Focus trap, Escape, scroll lock and focus return come from Radix.
 */
export function Modal({ title, onClose, children, wide, description }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; description?: string }) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent wide={wide} aria-describedby={description ? undefined : undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        </DialogHeader>
        <div className="min-w-0">{children}</div>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmModal({ title, body, confirm, danger, busy, onConfirm, onClose }: { title: string; body: ReactNode; confirm: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription className="sr-only">Confirm this action</DialogDescription></DialogHeader>
        <div className="text-sm text-muted-foreground">{body}</div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button variant={danger ? "destructive" : "default"} disabled={busy} onClick={onConfirm}>{busy && <Spinner />}{confirm}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export const fmtDate = (s: string | null | undefined) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "Never");
export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
