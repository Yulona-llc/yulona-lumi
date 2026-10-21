import { createReadStream, existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";
import preact from "@preact/preset-vite";

/** Serves the built IIFE at /widget.js so the embed snippet can load it during `vite`. */
function serveWidgetBundle(): Plugin {
  const file = resolve("dist/widget.js");
  return {
    name: "serve-widget-bundle",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/widget.js") return next();
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain");
          res.end("dist/widget.js is missing. Run bun run build in apps/widget.\n");
          return;
        }
        res.setHeader("Content-Type", "application/javascript");
        res.setHeader("Cache-Control", "no-store");
        createReadStream(file).pipe(res);
      });
    },
  };
}

// Single self-contained IIFE bundle: dist/widget.js
export default defineConfig({
  plugins: [preact(), serveWidgetBundle()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    target: "es2020",
    cssCodeSplit: false,
    lib: { entry: "src/index.tsx", name: "YulonaWidget", formats: ["iife"], fileName: () => "widget.js" },
    rollupOptions: { output: { inlineDynamicImports: true } },
    minify: "esbuild",
  },
  test: { environment: "jsdom", include: ["test/**/*.test.ts?(x)"] },
});
