import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";

/** Copies `value` to the clipboard (falls back to a hidden textarea where the async API is blocked). */
export default function CopyButton({ value, label, size = "sm" }: { value: string; label: string; size?: "sm" | "default" }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
      else {
        const t = document.createElement("textarea");
        t.value = value; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
        document.body.appendChild(t); t.select(); document.execCommand("copy"); t.remove();
      }
      setDone(true); toast.success("Copied to clipboard"); window.setTimeout(() => setDone(false), 2000);
    } catch { toast.error("Could not copy", { description: "Select the text and copy it by hand." }); }
  };
  return <Button type="button" variant="outline" size={size} aria-label={label} onClick={() => void copy()}>{done ? <Check /> : <Copy />}{done ? "Copied" : "Copy"}</Button>;
}
