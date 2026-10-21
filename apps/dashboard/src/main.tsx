import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "./api/queryClient";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { setFetchImpl } from "./api/client";
import { ThemeProvider } from "./components/theme";
import { MotionProvider } from "./components/motion";
import "./styles.css";

async function boot() {
  if (import.meta.env.VITE_MOCK_API === "true") {
    const { mockFetch } = await import("./api/mock");
    setFetchImpl(mockFetch);
  }
  const qc = createQueryClient();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ThemeProvider>
        <MotionProvider>
          <QueryClientProvider client={qc}>
            <BrowserRouter>
              <AuthProvider>
                <App />
              </AuthProvider>
            </BrowserRouter>
          </QueryClientProvider>
        </MotionProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}
// A deploy removes old hashed chunks: reload once so the tab picks up the new build instead of going blank.
window.addEventListener("vite:preloadError", () => {
  try { if (sessionStorage.getItem("yulona-chunk-reload") === "1") return; sessionStorage.setItem("yulona-chunk-reload", "1"); } catch { /* ignore */ }
  location.reload();
});
void boot();
