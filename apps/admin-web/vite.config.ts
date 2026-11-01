import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5178, strictPort: true },
  build: { target: "es2022", sourcemap: false },
  test: { environment: "jsdom", globals: true, setupFiles: ["./test/setup.ts"], css: false, testTimeout: 20000 },
});
