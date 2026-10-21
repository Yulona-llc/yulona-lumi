// Boots the real widget bundle for the dashboard's live preview. Config comes from the URL hash (JSON), never inline,
// so the page works under a strict `script-src 'self'` CSP.
(function () {
  var cfg = {};
  try { cfg = JSON.parse(decodeURIComponent(location.hash.slice(1))); } catch (e) { /* ignore */ }
  var scriptUrl = typeof cfg.scriptUrl === "string" && /^(\/|https?:\/\/)/.test(cfg.scriptUrl) ? cfg.scriptUrl : "/widget.js";
  window.YulonaConfig = { widgetKey: cfg.widgetKey, apiBase: cfg.apiBase, open: true };
  var s = document.createElement("script");
  s.src = scriptUrl;
  s.async = true;
  document.body.appendChild(s);
})();
