import { sign, verify } from "hono/jwt";
import { z } from "zod";

export const WIDGET_AUD = "yulona:widget";

const claimsSchema = z.object({
  aud: z.literal(WIDGET_AUD),
  sub: z.uuid(), // widget_sessions.id
  tid: z.uuid(),
  wid: z.uuid(),
  cid: z.uuid(), // conversation
  ctid: z.uuid(), // contact
  iat: z.number(),
  exp: z.number(),
});
export type WidgetSessionClaims = z.infer<typeof claimsSchema>;

export async function signWidgetSession(
  secret: string,
  p: { sessionId: string; tenantId: string; widgetId: string; conversationId: string; contactId: string; ttlSeconds: number },
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const claims: WidgetSessionClaims = {
    aud: WIDGET_AUD, sub: p.sessionId, tid: p.tenantId, wid: p.widgetId, cid: p.conversationId, ctid: p.contactId,
    iat, exp: iat + p.ttlSeconds,
  };
  return sign(claims, secret, "HS256");
}

export async function verifyWidgetSession(secret: string, token: string): Promise<WidgetSessionClaims | null> {
  try {
    const r = claimsSchema.safeParse(await verify(token, secret, "HS256"));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}
