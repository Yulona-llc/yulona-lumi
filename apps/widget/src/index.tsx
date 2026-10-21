import { mount } from "./mount";
import type { YulonaConfig } from "./types";

declare global {
  interface Window {
    YulonaConfig?: YulonaConfig;
    Yulona?: { destroy(): void };
  }
}

// Idempotent: a second script tag must not mount a second widget.
(function boot() {
  if (window.Yulona || !window.YulonaConfig?.widgetKey) {
    if (!window.YulonaConfig?.widgetKey) console.warn("[yulona] window.YulonaConfig.widgetKey is required");
    return;
  }
  const start = () => {
    const w = mount(window.YulonaConfig!);
    window.Yulona = { destroy: () => { w.destroy(); delete window.Yulona; } };
  };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", start, { once: true }) : start();
})();
