/** Cloudflare Turnstile (explicit rendering). The script is loaded from Cloudflare only when a widget enables it. */
export interface TurnstileOptions {
  siteKey: string;
  theme: "auto" | "light" | "dark";
  size: "normal" | "compact" | "flexible";
  appearance: "always" | "interaction-only";
  action?: string;
}

interface TurnstileApi {
  render(el: HTMLElement, o: Record<string, unknown>): string;
  remove(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let loading: Promise<TurnstileApi> | undefined;

export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = TURNSTILE_SRC;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile unavailable")));
    s.onerror = () => {
      loading = undefined; // allow a retry
      reject(new Error("turnstile failed to load"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** Renders the challenge into `el`; returns a cleanup function. */
export function renderTurnstile(
  el: HTMLElement, o: TurnstileOptions, cb: { onToken(t: string): void; onError(): void; onExpire(): void },
): () => void {
  let id: string | undefined;
  let gone = false;
  loadTurnstile()
    .then((t) => {
      if (gone) return;
      id = t.render(el, {
        sitekey: o.siteKey, theme: o.theme, size: o.size, appearance: o.appearance, ...(o.action ? { action: o.action } : {}),
        callback: cb.onToken, "error-callback": cb.onError, "expired-callback": cb.onExpire,
      });
    })
    .catch(() => !gone && cb.onError());
  return () => {
    gone = true;
    if (id) window.turnstile?.remove(id);
  };
}
