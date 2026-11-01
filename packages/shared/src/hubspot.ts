import { z } from "zod";

/** HubSpot internal property name (lower-case letters, digits, underscore). Unmapped properties are never sent. */
const prop = z.string().trim().regex(/^[a-z][a-z0-9_]{0,99}$/, "Use the HubSpot internal property name, e.g. lead_need");
export const HUBSPOT_LIFECYCLE_STAGES = ["subscriber", "lead", "marketingqualifiedlead", "salesqualifiedlead", "opportunity", "customer"] as const;

/** Where lead fields go in HubSpot. email, firstname, lastname and phone are always sent; the rest only when a property is named. */
export const hubspotMappingSchema = z.strictObject({
  properties: z.strictObject({
    need: prop.optional(),
    budget: prop.optional(),
    timeline: prop.optional(),
    score: prop.optional(),
    conversationLink: prop.optional(),
    source: prop.optional(),
  }).default({}),
  /** Value written to the `source` property. */
  sourceValue: z.string().trim().min(1).max(100).default("Lumi chat"),
  /** Lifecycle stage set when a contact is created (never changed on update: HubSpot only moves it forward). */
  lifecycleStage: z.enum(HUBSPOT_LIFECYCLE_STAGES).optional(),
  /** Also sync when a booking is confirmed. */
  syncOnBooked: z.boolean().default(true),
});
export type HubSpotMapping = z.infer<typeof hubspotMappingSchema>;

export const connectHubspotSchema = z.strictObject({
  token: z.string().trim().min(10).max(500),
  mapping: hubspotMappingSchema.optional(),
});
export const updateHubspotMappingSchema = z.strictObject({ mapping: hubspotMappingSchema });
export const hubspotTestContactSchema = z.strictObject({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().max(200).optional(),
});
