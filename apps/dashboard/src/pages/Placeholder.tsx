import { Link } from "react-router";
import { Hourglass } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, PageHeader } from "../features/common/ui";

const copy = {
  inbox: { title: "Inbox", body: "Conversations from every channel will land here, with AI handling the first reply and you stepping in on handoffs.", phase: "Phase 3 and 4" },
  contacts: { title: "Contacts", body: "One profile per person, with a timeline that follows them across channels.", phase: "Phase 4" },
  agents: { title: "Agents", body: "Configure your AI agent, add knowledge sources and test answers before going live.", phase: "Phase 2 and 4" },
  settings: { title: "Settings", body: "Widget appearance, allowed domains, embed code and team settings.", phase: "Phase 4" },
} as const;

export default function Placeholder({ kind }: { kind: keyof typeof copy }) {
  const c = copy[kind];
  return (
    <section className="max-w-2xl">
      <PageHeader title={c.title} />
      <Empty icon={<Hourglass className="size-6" />} title="Nothing here yet" body={`${c.body} Planned for ${c.phase}.`} action={<Button asChild variant="outline"><Link to="/overview">Back to overview</Link></Button>} />
    </section>
  );
}
