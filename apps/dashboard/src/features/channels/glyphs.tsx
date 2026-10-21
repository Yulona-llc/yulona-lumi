import type { ChannelKey } from "./api";
import { cn } from "@/lib/utils";

/** Simple inline brand glyphs. Brand colours are allowed here (docs/design/dashboard-ui.md): they identify the provider, nothing else. */
const BRAND: Record<ChannelKey, { bg: string; path: React.ReactNode }> = {
  whatsapp: {
    bg: "#25d366",
    path: <path fill="#fff" d="M12 3.5a8.4 8.4 0 0 0-7.2 12.7L3.6 20.5l4.4-1.15A8.4 8.4 0 1 0 12 3.5Zm0 1.6a6.8 6.8 0 1 1-3.6 12.6l-.3-.2-2.2.6.6-2.1-.2-.3A6.8 6.8 0 0 1 12 5.1Zm-2.6 3.3c-.15 0-.4.05-.6.3-.2.25-.8.8-.8 1.95s.85 2.25.95 2.4c.12.15 1.65 2.6 4.05 3.55 2 .78 2.4.63 2.85.58.43-.05 1.4-.57 1.6-1.12.2-.55.2-1.03.14-1.12-.06-.1-.22-.15-.46-.27l-1.5-.7c-.2-.1-.35-.13-.5.12-.15.25-.58.75-.7.9-.13.15-.26.17-.5.05-.23-.12-.97-.36-1.85-1.14-.68-.6-1.14-1.36-1.27-1.6-.14-.23 0-.36.1-.48l.35-.4c.1-.13.14-.22.2-.37.07-.15.04-.28-.02-.4l-.68-1.65c-.18-.43-.36-.37-.5-.38h-.43Z" />,
  },
  facebook: {
    bg: "#0a7cff",
    path: <path fill="#fff" d="M12 4C7.6 4 4 7.3 4 11.5c0 2.35 1.12 4.45 2.9 5.85V20l2.65-1.45c.45.1.93.15 1.45.15 4.4 0 8-3.3 8-7.5S16.4 4 12 4Zm.8 9.9-2-2.1-3.9 2.1 4.3-4.55 2.05 2.1 3.85-2.1-4.3 4.55Z" />,
  },
  instagram: {
    bg: "linear-gradient(135deg,#feda75 0%,#fa7e1e 28%,#d62976 55%,#962fbf 78%,#4f5bd5 100%)",
    path: <g fill="none" stroke="#fff" strokeWidth="1.7"><rect x="5" y="5" width="14" height="14" rx="4" /><circle cx="12" cy="12" r="3.2" /><circle cx="16.4" cy="7.6" r=".6" fill="#fff" /></g>,
  },
  telegram: {
    bg: "#229ed9",
    path: <path fill="#fff" d="M18.9 6.1 4.7 11.6c-.95.38-.94.92-.17 1.15l3.6 1.12 1.4 4.25c.17.47.09.66.58.66.38 0 .55-.17.76-.38l1.75-1.7 3.65 2.7c.67.37 1.15.18 1.32-.62l2.4-11.3c.25-.98-.37-1.43-1.1-1.1ZM9 13.5l7.2-4.5c.34-.2.65-.1.4.13l-6 5.4-.23 2.5L9 13.5Z" />,
  },
  slack: {
    bg: "#4a154b",
    path: <g><rect x="6.3" y="10.2" width="3.2" height="7" rx="1.6" fill="#36c5f0" /><rect x="10.2" y="6.3" width="7" height="3.2" rx="1.6" fill="#2eb67d" /><rect x="14.5" y="10.2" width="3.2" height="7" rx="1.6" fill="#ecb22e" /><rect x="6.3" y="14.5" width="7" height="3.2" rx="1.6" fill="#e01e5a" /></g>,
  },
};

export function ChannelGlyph({ channel, className }: { channel: ChannelKey; className?: string }) {
  const b = BRAND[channel];
  return (
    <span aria-hidden="true" className={cn("grid size-11 shrink-0 place-items-center rounded-xl shadow-sm", className)} style={{ background: b.bg }}>
      <svg viewBox="0 0 24 24" className="size-6">{b.path}</svg>
    </span>
  );
}
