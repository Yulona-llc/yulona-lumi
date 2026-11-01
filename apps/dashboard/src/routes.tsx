import { lazyWithReload as lazy } from "@/lib/lazy";
import { Route } from "react-router";

/** Feature routes rendered inside the authenticated Shell. One line per route; every component lazy. */
const OverviewPage = lazy(() => import("./features/overview/OverviewPage"));
const Inbox = lazy(() => import("./features/inbox/InboxRoutes"));
const Contacts = lazy(() => import("./features/contacts/ContactsRoutes"));
const AgentsPage = lazy(() => import("./features/agents/AgentsPage"));
const AgentEditor = lazy(() => import("./features/agents/AgentEditor"));
const KnowledgePage = lazy(() => import("./features/knowledge/KnowledgePage"));
const SettingsLayout = lazy(() => import("./features/settings/SettingsLayout"));
const WidgetConfigPage = lazy(() => import("./features/widget-config/WidgetConfigPage"));
const TeamPage = lazy(() => import("./features/team/TeamPage"));
const ApiKeysPage = lazy(() => import("./features/settings/ApiKeysPage"));
const AuditPage = lazy(() => import("./features/audit/AuditPage"));
const AccountPage = lazy(() => import("./features/settings/AccountPage"));
const ChannelsPage = lazy(() => import("./features/channels/ChannelsPage"));
const BillingPage = lazy(() => import("./features/billing/BillingPage"));
const WebhooksPage = lazy(() => import("./features/integrations-ui/WebhooksPage"));
const DataPage = lazy(() => import("./features/integrations-ui/DataPage"));
const TicketsPage = lazy(() => import("./features/tickets/TicketsPage"));
const BookingsPage = lazy(() => import("./features/bookings/BookingsPage"));
const CalendarSettings = lazy(() => import("./features/bookings/CalendarSettings"));
const AttentionPage = lazy(() => import("./features/attention/AttentionPage"));
const OpsSettingsPage = lazy(() => import("./features/ops-settings/OpsSettingsPage"));
const CannedPage = lazy(() => import("./features/ops-settings/CannedPage"));
const UsagePage = lazy(() => import("./features/usage/UsagePage"));
const ConnectionsPage = lazy(() => import("./features/tools/ConnectionsPage"));
const TagsPage = lazy(() => import("./features/ops-settings/TagsPage"));
const AgentBuilderPage = lazy(() => import("./features/agent-builder/AgentBuilderPage"));

export const featureRoutes = (
  <>
    <Route path="overview" element={<OverviewPage />} />
    <Route path="inbox/*" element={<Inbox />} />
    <Route path="contacts/*" element={<Contacts />} />
    <Route path="agents" element={<AgentsPage />} />
    <Route path="agents/new-ai" element={<AgentBuilderPage />} />
    <Route path="agents/:id" element={<AgentEditor />} />
    <Route path="knowledge" element={<KnowledgePage />} />
    <Route path="channels" element={<ChannelsPage />} />
    <Route path="tickets" element={<TicketsPage />} />
    <Route path="bookings" element={<BookingsPage />} />
    <Route path="attention" element={<AttentionPage />} />
    <Route path="settings" element={<SettingsLayout />}>
      <Route index element={null} />
      <Route path="widget" element={<WidgetConfigPage />} />
      <Route path="team" element={<TeamPage />} />
      <Route path="api-keys" element={<ApiKeysPage />} />
      <Route path="webhooks" element={<WebhooksPage />} />
      <Route path="billing" element={<BillingPage />} />
      <Route path="usage" element={<UsagePage />} />
      <Route path="data" element={<DataPage />} />
      <Route path="integrations" element={<CalendarSettings />} />
      <Route path="operations" element={<OpsSettingsPage />} />
      <Route path="canned" element={<CannedPage />} />
      <Route path="tags" element={<TagsPage />} />
      <Route path="connections" element={<ConnectionsPage />} />
      <Route path="audit" element={<AuditPage />} />
      <Route path="account" element={<AccountPage />} />
    </Route>
  </>
);
