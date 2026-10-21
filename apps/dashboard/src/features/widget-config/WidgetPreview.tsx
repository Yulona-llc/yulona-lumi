import { useMemo } from "react";
import type { WidgetConfig } from "@yulona/shared";

/** Builds the iframe document that boots the real apps/widget bundle through its public mount API (window.YulonaConfig + widget.js). */
export function previewDoc(o: { widgetKey: string; apiBase: string; scriptUrl: string }): string {
  const cfg = JSON.stringify({ widgetKey: o.widgetKey, apiBase: o.apiBase, open: true }).replace(/</g, "\\u003c");
  const src = JSON.stringify(o.scriptUrl).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#f4f6f9;font:14px system-ui;color:#51607a}p{padding:16px}</style></head><body><p>Site preview</p><script>window.YulonaConfig=${cfg};var s=document.createElement("script");s.src=${src};s.async=true;document.body.appendChild(s);</script></body></html>`;
}

/** Instant, local approximation of the unsaved draft (colors, text, position). */
export function DraftCard({ cfg, prechatEnabled }: { cfg: WidgetConfig; prechatEnabled: boolean }) {
  const color = cfg.primaryColor ?? "#f97316";
  const dark = cfg.theme === "dark";
  return (
    <div className={`flex ${cfg.position === "left" ? "justify-start" : "justify-end"}`}>
      <div className="w-full max-w-xs overflow-hidden rounded-2xl border shadow-lg" style={{ background: dark ? "#14171f" : "#fff", color: dark ? "#e8ecf4" : "#0f1b2d" }} aria-label="Draft widget preview" role="img">
        <div className="px-4 py-3 text-white" style={{ background: color }}>
          <p className="font-semibold">{cfg.title || "Chat with us"}</p><p className="text-xs opacity-90">{cfg.subtitle || "We reply in minutes"}</p>
        </div>
        <div className="space-y-2 p-4 text-sm">
          <p className="inline-block rounded-2xl px-3 py-2" style={{ background: dark ? "#232837" : "#eef1f6" }}>{cfg.welcomeMessage || "Hi! How can we help?"}</p>
          {prechatEnabled && <p className="text-xs opacity-70">Visitors fill the pre-chat form first.</p>}
          <div className="rounded-lg border px-3 py-2 opacity-70" style={{ borderColor: dark ? "#3a4256" : "#dde3ec" }}>{cfg.inputPlaceholder || "Type your message"}</div>
        </div>
        <div className="px-4 pb-3 text-right"><span className="inline-block rounded-full px-3 py-1 text-xs font-semibold text-white" style={{ background: color }}>{cfg.launcherLabel || "Chat"}</span></div>
      </div>
    </div>
  );
}

type PreviewOpts = { widgetKey: string; apiBase: string; scriptUrl: string };

/**
 * Production CSP (`script-src 'self'`) blocks inline scripts, including those in srcdoc iframes (they inherit the parent CSP).
 * So the real deployment frames the static same-origin /widget-preview.html (config in the URL hash). `doc` (srcdoc) is the fallback for dev/tests.
 */
export function LiveFrame({ doc, opts }: { doc: string; opts?: PreviewOpts }) {
  const key = useMemo(() => doc.length + doc.slice(0, 80), [doc]);
  const cls = "h-[28rem] w-full rounded-xl border bg-card";
  if (opts) return <iframe key={key} title="Live widget preview" src={`/widget-preview.html#${encodeURIComponent(JSON.stringify(opts))}`} sandbox="allow-scripts allow-same-origin" className={cls} />;
  return <iframe key={key} title="Live widget preview" srcDoc={doc} sandbox="allow-scripts allow-same-origin" className={cls} />;
}
