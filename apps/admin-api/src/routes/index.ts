import type { Deps } from "../context";
import type { Registrar } from "../route";
import { registerAdminRoutes } from "./admins";
import { registerAuthRoutes } from "./auth";
import { registerCatalogRoutes } from "./catalog";
import { registerOpsRoutes } from "./ops";
import { registerSupportRoutes } from "./support";
import { registerTenantRoutes } from "./tenants";

/** Registration order matters for Hono: static paths (/tenants/export, /tenants/tags/bulk) come before /tenants/:id. */
export function registerAll(reg: Registrar, d: Deps) {
  registerAuthRoutes(reg, d);
  registerOpsRoutes(reg, d);
  registerSupportRoutes(reg, d); // before tenants: owns /tenants/tags/bulk
  registerTenantRoutes(reg, d);
  registerCatalogRoutes(reg, d);
  registerAdminRoutes(reg, d);
}
