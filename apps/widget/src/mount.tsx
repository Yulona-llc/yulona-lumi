import { render } from "preact";
import { App } from "./App";
import { createApi, resolveApiBase, type Fetch } from "./api";
import { Chat } from "./chat";
import { CSS } from "./styles";
import type { YulonaConfig } from "./types";

function scriptOrigin(): string {
  try {
    const cs = document.currentScript as HTMLScriptElement | null;
    if (cs?.src) return new URL(cs.src).origin;
  } catch {
    /* ignore */
  }
  return location.origin;
}

export function mount(cfg: YulonaConfig, fetchImpl?: Fetch): { destroy(): void; chat: Chat } {
  const host = document.createElement("div");
  host.setAttribute("data-yulona-widget", "");
  const root = host.attachShadow({ mode: "open" });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const st = document.createElement("style");
    st.textContent = CSS;
    root.appendChild(st);
  }
  const mountPoint = document.createElement("div");
  root.appendChild(mountPoint);
  document.body.appendChild(host);

  const base = resolveApiBase(cfg.apiBase ?? cfg.apiUrl, scriptOrigin());
  const api = createApi(base, cfg.widgetKey, fetchImpl);
  const chat = new Chat(api, cfg.widgetKey);
  render(<App chat={chat} startOpen={cfg.open} root={root} />, mountPoint);
  return {
    chat,
    destroy() {
      render(null, mountPoint);
      chat.forget();
      host.remove();
    },
  };
}
