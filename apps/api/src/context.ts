import type { Role } from "@yulona/shared";

export interface AuthContext {
  userId: string;
  tenantId: string;
  role: Role;
  /** Set only for impersonation tokens (platform admin id / session id). */
  impersonatorId?: string;
  impersonationSessionId?: string;
}
export type AppEnv = {
  Variables: {
    requestId: string;
    ip: string;
    auth: AuthContext;
  };
};
