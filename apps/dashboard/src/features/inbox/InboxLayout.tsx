import { Outlet, useMatch } from "react-router";
import { cn } from "@/lib/utils";
import ConversationList from "./ConversationList";

/**
 * Zones: list (360px) | thread | contact panel (xl+). On phones the list and the thread are separate, route-driven screens.
 * Sits inside Shell's full-bleed <main>: edge to edge on phones, one rounded surface from md.
 */
export default function InboxLayout() {
  const detail = useMatch("/inbox/:id");
  return (
    <div className="@container flex h-full min-h-0 overflow-hidden bg-card md:rounded-2xl md:border md:shadow-xs">
      <div className={cn("w-full shrink-0 flex-col border-r md:flex md:w-[360px]", detail ? "hidden" : "flex")}>
        <ConversationList activeId={detail?.params.id} />
      </div>
      <div className={cn("relative min-w-0 flex-1 flex-col bg-background md:flex", detail ? "flex" : "hidden")}>
        <Outlet />
      </div>
    </div>
  );
}
