import { z } from "zod";

/** Bump when a breaking change is made; widgets must degrade gracefully on unknown types. */
export const WIDGET_UI_SCHEMA_VERSION = 1 as const;

const base = { id: z.string().max(64).optional() };

export const messageComponent = z.strictObject({ ...base, type: z.literal("message"), text: z.string().max(4000) });
export const buttonsComponent = z.strictObject({
  ...base,
  type: z.literal("buttons"),
  buttons: z.array(z.strictObject({ label: z.string().max(80), value: z.string().max(200) })).min(1).max(10),
});
export const cardComponent = z.strictObject({
  ...base,
  type: z.literal("card"),
  title: z.string().max(200),
  body: z.string().max(2000).optional(),
  imageUrl: z.url().optional(),
  actions: z.array(z.strictObject({ label: z.string().max(80), value: z.string().max(200) })).max(5).optional(),
});
export const formComponent = z.strictObject({
  ...base,
  type: z.literal("form"),
  submitLabel: z.string().max(80).default("Submit"),
  fields: z
    .array(
      z.strictObject({
        name: z.string().max(64),
        label: z.string().max(120),
        kind: z.enum(["text", "email", "phone", "textarea", "select"]),
        required: z.boolean().default(false),
        options: z.array(z.string().max(120)).max(50).optional(),
      }),
    )
    .min(1)
    .max(20),
});
export const calendarComponent = z.strictObject({
  ...base,
  type: z.literal("calendar"),
  timezone: z.string().max(64),
  slots: z.array(z.strictObject({ start: z.iso.datetime(), end: z.iso.datetime() })).max(100),
});

export const widgetUIComponentSchema = z.discriminatedUnion("type", [
  messageComponent,
  formComponent,
  calendarComponent,
  buttonsComponent,
  cardComponent,
]);
export type WidgetUIComponent = z.infer<typeof widgetUIComponentSchema>;

export const widgetUISchema = z.strictObject({
  version: z.literal(WIDGET_UI_SCHEMA_VERSION),
  components: z.array(widgetUIComponentSchema).max(20),
});
export type WidgetUISchema = z.infer<typeof widgetUISchema>;
