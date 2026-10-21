import { z } from "zod";

export const ROLES = ["owner", "admin", "agent", "viewer"] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;
