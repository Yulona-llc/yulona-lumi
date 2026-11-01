import { z } from "zod";
import { contactSchema, messageDtoSchema, pageSchema, channelSchema } from "@yulona/shared";
import { request } from "../../api/client";
import { qs } from "../inbox/api";

export const contactPage = pageSchema(contactSchema);
export const timelineItem = z.object({
  type: z.enum(["message", "conversation_started"]),
  at: z.string(),
  conversationId: z.uuid(),
  channel: channelSchema,
  message: messageDtoSchema.nullable().optional(),
});
export type TimelineItem = z.infer<typeof timelineItem>;
const timelinePage = pageSchema(timelineItem);

export interface ContactPatch {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  customAttributes?: Record<string, string | number | boolean | null>;
}

export const contactsApi = {
  list: (q: string | undefined, cursor?: string) => request(`/contacts${qs({ q, limit: 30, cursor })}`, { auth: true, schema: contactPage }),
  get: (id: string) => request(`/contacts/${id}`, { auth: true, schema: contactSchema }),
  create: (b: { name?: string; email?: string; phone?: string }) => request("/contacts", { method: "POST", auth: true, body: b, schema: contactSchema }),
  patch: (id: string, b: ContactPatch) => request(`/contacts/${id}`, { method: "PATCH", auth: true, body: b, schema: contactSchema }),
  remove: (id: string) => request(`/contacts/${id}`, { method: "DELETE", auth: true }),
  timeline: (id: string, cursor?: string) => request(`/contacts/${id}/timeline${qs({ limit: 30, cursor })}`, { auth: true, schema: timelinePage }),
  block: (id: string, reason?: string) => request(`/contacts/${id}/block`, { method: "POST", auth: true, body: reason ? { reason } : {}, schema: contactSchema }),
  unblock: (id: string) => request(`/contacts/${id}/unblock`, { method: "POST", auth: true, schema: contactSchema }),
  merge: (id: string, sourceContactId: string) => request(`/contacts/${id}/merge`, { method: "POST", auth: true, body: { sourceContactId } }),
};

/** Attribute keys must match the server rule. */
export const ATTR_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
