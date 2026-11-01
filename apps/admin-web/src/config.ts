declare global {
  interface Window {
    __ADMIN_CONFIG__?: { apiUrl?: string };
  }
}

const clean = (u: string | undefined) => (u ?? "").trim().replace(/\/+$/, "");

/** Runtime config.js -> build-time VITE_API_URL -> same origin (""). */
export function getApiOrigin(): string {
  return clean(window.__ADMIN_CONFIG__?.apiUrl) || clean(import.meta.env.VITE_ADMIN_API_URL);
}
export const apiBase = () => `${getApiOrigin()}/api/v1`;
