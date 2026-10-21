import { Route, Routes } from "react-router";
import { MessageSquareText } from "lucide-react";
import { useRealtimeSync } from "../realtime/hooks";
import InboxLayout from "./InboxLayout";
import ConversationView from "./ConversationView";

export default function InboxRoutes() {
  useRealtimeSync();
  return (
    <Routes>
      <Route element={<InboxLayout />}>
        <Route index element={<EmptyDetail />} />
        <Route path=":id" element={<ConversationView />} />
      </Route>
    </Routes>
  );
}

function EmptyDetail() {
  const kbd = "rounded border bg-muted px-1.5 font-mono text-xs";
  return (
    <div className="grid h-full place-items-center p-8 text-center text-muted-foreground">
      <div>
        <span className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-accent text-accent-foreground"><MessageSquareText className="size-6" /></span>
        <p className="font-display text-lg font-semibold text-foreground">Select a conversation</p>
        <p className="mt-1.5 text-sm">Pick one from the list. Press <kbd className={kbd}>j</kbd> / <kbd className={kbd}>k</kbd> to move and <kbd className={kbd}>/</kbd> to search.</p>
      </div>
    </div>
  );
}
