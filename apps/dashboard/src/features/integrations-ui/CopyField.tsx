import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { copy } from "./http";

/** Monospace value with a copy button. Toasts on copy; the button label flips to "Copied" for a moment. */
export function CopyField({ label, value, testId, wrap = false, className }: { label: string; value: string; testId?: string; wrap?: boolean; className?: string }) {
  const [done, setDone] = useState(false);
  const go = () => {
    copy(value); setDone(true); toast.success(`${label} copied`);
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <div className={cn("flex items-start gap-2", className)}>
      <code data-testid={testId} title={value} className={cn("min-w-0 flex-1 rounded-lg border bg-muted px-3 py-2 font-mono text-xs leading-5", wrap ? "break-all" : "truncate")}>{value}</code>
      <Button type="button" variant="outline" size="sm" onClick={go} aria-label={`Copy ${label}`}>
        {done ? <Check className="text-success" /> : <Copy />}<span className="max-sm:sr-only">{done ? "Copied" : "Copy"}</span>
      </Button>
    </div>
  );
}
