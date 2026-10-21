import { useEffect, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { RealtimeEvent } from "@yulona/shared";
import { realtime, type ConnState } from "./socket";
import type { MessageView, MsgPage } from "../inbox/api";

export function useConnectionState(): ConnState {
  const [s, setS] = useState<ConnState>(realtime.state);
  useEffect(() => realtime.onState(setS), []);
  return s;
}

/** Applies an event to the react-query cache. Exported for tests. */
export function applyEvent(qc: QueryClient, e: RealtimeEvent) {
  if (e.type === "message.created") {
    const m = e.message as MessageView;
    qc.setQueryData<MsgPage>(["messages", e.conversationId], (old) => {
      if (!old) return old;
      if (old.items.some((x) => x.id === m.id)) return old;
      // Drop the optimistic copy of our own send, if any.
      const items = (old.items as MessageView[]).filter((x) => !(x.pending && x.senderType === m.senderType && x.content === m.content));
      return { ...old, items: [...items, m] };
    });
    void qc.invalidateQueries({ queryKey: ["conversations"] });
  } else if (e.type === "conversation.updated") {
    void qc.invalidateQueries({ queryKey: ["conversations"] });
    void qc.invalidateQueries({ queryKey: ["conversation", e.conversation.id] });
  } else if (e.type === "ready") {
    // reconnect: catch up
    void qc.invalidateQueries({ queryKey: ["conversations"] });
    void qc.invalidateQueries({ queryKey: ["messages"] });
  }
}

/** Mount once per feature tree that needs live data. */
export function useRealtimeSync() {
  const qc = useQueryClient();
  useEffect(() => {
    realtime.start();
    const off = realtime.on((e) => applyEvent(qc, e));
    return () => { off(); realtime.stop(); };
  }, [qc]);
}

export function useTyping(conversationId: string | undefined): boolean {
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    setTyping(false);
    let t: number | undefined;
    const off = realtime.on((e) => {
      if (e.type === "typing" && e.conversationId === conversationId && e.from === "contact") {
        setTyping(e.typing);
        window.clearTimeout(t);
        if (e.typing) t = window.setTimeout(() => setTyping(false), 6000);
      }
    });
    return () => { off(); window.clearTimeout(t); };
  }, [conversationId]);
  return typing;
}
