import type { Role } from "../api/types";

/** Mirrors the role matrix of docs/api/platform-admin.md. The API enforces it; the UI only reflects it. */
export const PERMS = {
  impersonate: ["owner", "support"],
  impersonateWrite: ["owner"],
  tenantLifecycle: ["owner"],
  changePlan: ["owner", "billing"],
  grantCredits: ["owner", "billing"],
  notesAndTags: ["owner", "support"],
  resendInvite: ["owner", "support"],
  jobActions: ["owner", "support"],
  tenantFlags: ["owner"],
  editCatalogue: ["owner", "billing"],
  editProviders: ["owner"],
  editFeatureFlags: ["owner"],
  exportAudit: ["owner"],
  manageAdmins: ["owner"],
} as const satisfies Record<string, readonly Role[]>;
export type Perm = keyof typeof PERMS;

export const can = (role: Role | undefined, p: Perm): boolean => !!role && (PERMS[p] as readonly Role[]).includes(role);
export const whoCan = (p: Perm): string => `Requires the ${PERMS[p].join(" or ")} role`;
export const roleLabel: Record<Role, string> = { owner: "Owner", support: "Support", billing: "Billing" };
