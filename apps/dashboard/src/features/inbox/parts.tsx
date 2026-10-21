import { useEffect, useState } from "react";
import { Bot, Camera, Globe, Hash, MessageCircle, MessageSquare, Send, type LucideIcon } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { CHANNEL_LABEL, contactLabel, initials } from "./format";

export const CHANNEL_ICON: Record<string, LucideIcon> = {
  widget: Globe, whatsapp: MessageCircle, messenger: MessageSquare, instagram: Camera, telegram: Send, slack: Hash,
};

/** Small glyph for a channel, with an accessible name when `labelled`. */
export function ChannelGlyph({ channel, className, labelled }: { channel: string; className?: string; labelled?: boolean }) {
  const Icon = CHANNEL_ICON[channel] ?? Globe;
  return <Icon className={cn("size-3.5", className)} aria-label={labelled ? (CHANNEL_LABEL[channel] ?? channel) : undefined} aria-hidden={labelled ? undefined : true} role={labelled ? "img" : undefined} />;
}

/** Contact avatar with the channel glyph pinned to its corner. */
export function ContactAvatar({ contact, channel, className, size = "md" }: { contact: { name: string | null; email: string | null; phone: string | null }; channel?: string; className?: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={cn("relative inline-flex shrink-0 self-start", className)}>
      <Avatar className={size === "lg" ? "size-14" : size === "sm" ? "size-9" : "size-11 sm:size-10"}><AvatarFallback className={cn("bg-secondary text-secondary-foreground", size === "lg" && "text-base")}>{initials(contactLabel(contact))}</AvatarFallback></Avatar>
      {channel && (
        <span className="absolute -bottom-0.5 -right-0.5 grid size-[18px] place-items-center rounded-full border-2 border-card bg-sidebar text-sidebar-foreground">
          <ChannelGlyph channel={channel} className="size-2.5" />
        </span>
      )}
    </span>
  );
}

export function AiAvatar({ className }: { className?: string }) {
  return <span className={cn("grid size-7 shrink-0 place-items-center rounded-full bg-sidebar text-primary", className)} aria-hidden="true"><Bot className="size-4" /></span>;
}

/** matchMedia as state. Assumes a wide screen where matchMedia does not exist (tests, SSR). */
export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : true);
  const [m, setM] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return m;
}
