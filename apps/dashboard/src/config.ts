declare global {
  interface Window {
    __YULONA_CONFIG__?: { apiUrl?: string };
  }
}

function clean(u: string | undefined): string {
  return (u ?? "").trim().replace(/\/+$/, "");
}

/** Runtime config.js → build-time VITE_API_URL → same-origin ("" ). */
export function getApiOrigin(): string {
  return clean(window.__YULONA_CONFIG__?.apiUrl) || clean(import.meta.env.VITE_API_URL);
}

export const apiBase = () => `${getApiOrigin()}/api/v1`;
export const MOCK = import.meta.env.VITE_MOCK_API === "true";
