import type { Db } from "@yulona/db";
import { CALENDAR_TOOL_MANIFESTS, CalendlyClient, executeCalendarTool, GoogleCalendarClient, loadTenantCalendarAny } from "@yulona/ops";

/**
 * Calendar tools for the AI runtime (`externalTools`). The calendar is resolved PER TENANT (the tenant's default connected
 * provider: Google or Calendly); a provider whose server credentials are not configured is skipped.
 * Needs ENCRYPTION_KEY plus GOOGLE_CLIENT_ID/SECRET and/or CALENDLY_CLIENT_ID/SECRET; otherwise tools report calendar_not_connected.
 */
export function buildCalendarExternalTools(db: Db, env: Record<string, string | undefined> = process.env, fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>) {
  const key = env.ENCRYPTION_KEY;
  const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? new GoogleCalendarClient({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: env.GOOGLE_REDIRECT_URI ?? "" }, fetchImpl) : null;
  const calendly = env.CALENDLY_CLIENT_ID && env.CALENDLY_CLIENT_SECRET
    ? new CalendlyClient({
        clientId: env.CALENDLY_CLIENT_ID, clientSecret: env.CALENDLY_CLIENT_SECRET, redirectUri: env.CALENDLY_REDIRECT_URI ?? "" }, fetchImpl) : null;
  return {
    manifests: Object.values(CALENDAR_TOOL_MANIFESTS),
    execute: async (ctx: { tenantId: string; conversationId?: string | null }, name: string, input: Record<string, unknown>) => {
      const calendar = key && (google || calendly) ? await loadTenantCalendarAny({ db, encryptionKey: key, google, calendly }, ctx.tenantId) : null;
      return executeCalendarTool({ db, tenantId: ctx.tenantId, conversationId: ctx.conversationId!, calendar }, name, input);
    },
  };
}
