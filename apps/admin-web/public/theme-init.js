// Runs before first paint (external file: the CSP forbids inline scripts) so there is no light/dark flash.
try {
  var t = localStorage.getItem("lumi-admin-theme") || "system";
  var dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
} catch (e) {}
