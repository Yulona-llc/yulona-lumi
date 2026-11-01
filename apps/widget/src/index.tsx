import { mount } from "./mount";
import type { YulonaConfig } from "./types";

declare global {
  interface Window {
    YulonaConfig?: YulonaConfig;
    LumiConfig?: YulonaConfig;
    Yulona?: { destroy(): void };
    Lumi?: { destroy(): void };
  }
}

// Idempotent: a second script tag must not mount a second widget.
// The product is called Lumi: window.Lumi / window.LumiConfig are aliases of window.Yulona / window.YulonaConfig (either config object works).
(function boot() {
  const cfg = window.LumiConfig?.widgetKey ? window.LumiConfig : window.YulonaConfig;
  if (window.Yulona || window.Lumi || !cfg?.widgetKey) {
    if (!cfg?.widgetKey) console.warn("[lumi] window.LumiConfig.widgetKey (or window.YulonaConfig.widgetKey) is required");
    return;
  }
  const start = () => {
    const w = mount(cfg);
    const handle = { destroy: () => { w.destroy(); delete window.Yulona; delete window.Lumi; } };
    window.Yulona = handle;
    window.Lumi = handle;
  };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", start, { once: true }) : start();
})();
