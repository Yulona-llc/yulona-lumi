import { useId, type InputHTMLAttributes, type ReactNode } from "react";

export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}

export function FullPageSpinner({ label }: { label: string }) {
  return (
    <div role="status" className="grid h-full place-items-center text-ink-2">
      <div className="flex items-center gap-3"><Spinner /><span>{label}…</span></div>
    </div>
  );
}

export function Field({ label, error, hint, ...p }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  const id = useId();
  const d = `${id}-d`;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium">{label}</label>
      <input id={id} className="field" aria-invalid={error ? true : undefined} aria-describedby={error || hint ? d : undefined} {...p} />
      {(error || hint) && (
        <p id={d} className={`mt-1.5 text-sm ${error ? "text-danger" : "text-ink-2"}`}>{error ?? hint}</p>
      )}
    </div>
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return <div role="alert" className="rounded-lg border border-danger/40 bg-danger/5 px-3 py-2.5 text-sm text-danger">{children}</div>;
}
