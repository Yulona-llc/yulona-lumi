/** All styling lives inside the shadow root. Applied via adoptedStyleSheets (CSP-safe), <style> fallback. */
export const CSS = `
:host{all:initial}
*,*::before,*::after{box-sizing:border-box}
.y-root{--c:#4f46e5;--c-fg:#fff;--bg:#fff;--fg:#14161f;--mut:#5b6075;--bd:#e3e5ee;--bub:#f1f2f8;--err:#b3261e;
  font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--fg);position:fixed;bottom:20px;z-index:2147483000}
.y-root.right{right:20px}.y-root.left{left:20px}
.y-root.dark{--bg:#161822;--fg:#eceef6;--mut:#a3a8be;--bd:#2c2f42;--bub:#232638;--err:#ff8a80}
@media (prefers-color-scheme:dark){.y-root.auto{--bg:#161822;--fg:#eceef6;--mut:#a3a8be;--bd:#2c2f42;--bub:#232638;--err:#ff8a80}}
.y-sub{display:block;font-size:11px;font-weight:400;opacity:.85}
button,input,select,textarea{font:inherit;color:inherit}
:focus-visible{outline:3px solid var(--c);outline-offset:2px}
.y-launch{width:56px;height:56px;border-radius:50%;border:0;background:var(--c);color:var(--c-fg);cursor:pointer;display:grid;place-items:center;
  box-shadow:0 6px 20px rgba(20,22,31,.28);transition:transform .15s}
.y-launch:hover{transform:scale(1.06)}
.y-launch svg{width:26px;height:26px}
.y-panel{position:absolute;bottom:68px;width:min(380px,calc(100vw - 24px));height:min(640px,calc(100vh - 110px));display:flex;flex-direction:column;
  background:var(--bg);border:1px solid var(--bd);border-radius:16px;overflow:hidden;box-shadow:0 16px 48px rgba(20,22,31,.28);animation:y-in .18s ease-out}
.right .y-panel{right:0}.left .y-panel{left:0}
@media (max-width:480px){.y-root{bottom:0;right:0;left:0}.y-launch{position:fixed;bottom:16px}.right .y-launch{right:16px}.left .y-launch{left:16px}
  .y-panel{position:fixed;inset:0;width:100%;height:100%;border-radius:0;border:0}}
@keyframes y-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.y-head{display:flex;align-items:center;gap:10px;padding:12px 14px;background:var(--c);color:var(--c-fg)}
.y-head img{width:28px;height:28px;border-radius:50%;object-fit:cover}
.y-head h2{margin:0;font-size:15px;font-weight:600;flex:1}
.y-head .y-st{font-size:11px;opacity:.85}
.y-x{background:transparent;border:0;color:inherit;cursor:pointer;border-radius:8px;padding:6px;line-height:0}
.y-x:hover{background:rgba(255,255,255,.18)}
.y-log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;scroll-behavior:smooth}
.y-msg{max-width:86%;display:flex;flex-direction:column;gap:6px}
.y-msg.user{align-self:flex-end;align-items:flex-end}
.y-bubble{background:var(--bub);padding:8px 12px;border-radius:14px 14px 14px 4px;overflow-wrap:anywhere;white-space:pre-wrap}
.y-msg.user .y-bubble{background:var(--c);color:var(--c-fg);border-radius:14px 14px 4px 14px}
.y-msg.user .y-bubble a{color:inherit}
.y-who{font-size:11px;color:var(--mut)}
.y-text{margin:0}
.y-bubble a{color:var(--c);text-decoration:underline}
.y-meta{font-size:11px;color:var(--mut)}
.y-meta button{background:none;border:0;color:var(--err);text-decoration:underline;cursor:pointer;padding:0}
.y-card{border:1px solid var(--bd);border-radius:12px;overflow:hidden;background:var(--bg);white-space:normal}
.y-card img{display:block;width:100%;max-height:150px;object-fit:cover}
.y-card h4{margin:10px 12px 2px;font-size:14px}.y-card p{margin:0 12px 10px;color:var(--mut)}
.y-card .y-btns{padding:0 12px 12px}
.y-btns,.y-days,.y-slots{display:flex;flex-wrap:wrap;gap:6px}
.y-chip{border:1px solid var(--c);color:var(--c);background:transparent;border-radius:999px;padding:6px 12px;cursor:pointer;min-height:32px}
.y-chip:hover:not(:disabled){background:var(--c);color:var(--c-fg)}
.y-chip[aria-pressed=true],.y-chip[aria-selected=true]{background:var(--c);color:var(--c-fg)}
.y-chip:disabled{opacity:.55;cursor:default}
.y-form,.y-cal{display:flex;flex-direction:column;gap:10px;border:1px solid var(--bd);border-radius:12px;padding:12px;background:var(--bg);width:100%;min-width:260px;white-space:normal}
.y-field{display:flex;flex-direction:column;gap:3px}
.y-field label{font-size:12px;font-weight:600}
.y-field input,.y-field select,.y-field textarea{border:1px solid var(--bd);background:var(--bg);border-radius:8px;padding:8px 10px;width:100%}
.y-field [aria-invalid=true]{border-color:var(--err)}
.y-err{color:var(--err);font-size:12px;margin:0}
.y-hint{margin:0;color:var(--mut);font-size:11px}
.y-primary{background:var(--c);color:var(--c-fg);border:0;border-radius:10px;padding:9px 14px;cursor:pointer;font-weight:600;min-height:40px}
.y-primary:disabled{opacity:.6;cursor:default}
.y-compose{display:flex;gap:8px;padding:10px;border-top:1px solid var(--bd);align-items:flex-end}
.y-compose textarea{flex:1;resize:none;border:1px solid var(--bd);background:var(--bg);border-radius:12px;padding:9px 12px;max-height:110px;min-height:40px}
.y-send{background:var(--c);color:var(--c-fg);border:0;border-radius:12px;width:40px;height:40px;cursor:pointer;display:grid;place-items:center}
.y-send:disabled{opacity:.5;cursor:default}
.y-prechat{padding:18px;display:flex;flex-direction:column;gap:12px;overflow-y:auto}
.y-prechat p{margin:0;color:var(--mut)}
.y-typing{display:inline-flex;gap:4px;padding:10px 12px;background:var(--bub);border-radius:14px 14px 14px 4px;align-self:flex-start}
.y-typing i{width:6px;height:6px;border-radius:50%;background:var(--mut);animation:y-b 1.2s infinite ease-in-out}
.y-typing i:nth-child(2){animation-delay:.15s}.y-typing i:nth-child(3){animation-delay:.3s}
@keyframes y-b{0%,60%,100%{opacity:.35;transform:none}30%{opacity:1;transform:translateY(-3px)}}
.y-banner{background:#fff4d6;color:#5c4400;padding:6px 14px;font-size:12px}
.y-center{padding:24px;text-align:center;color:var(--mut);display:flex;flex-direction:column;gap:10px;align-items:center;margin:auto}
.y-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;
