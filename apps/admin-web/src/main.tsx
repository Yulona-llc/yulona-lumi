import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import "./styles.css";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { createQueryClient } from "./api/queryClient";
import { ThemeProvider } from "./components/theme";
import { MotionProvider } from "./components/motion";
import { Toaster } from "./components/ui/sonner";

const qc = createQueryClient();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <MotionProvider>
        <QueryClientProvider client={qc}>
          <BrowserRouter>
            <AuthProvider>
              <App />
              <Toaster />
            </AuthProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </MotionProvider>
    </ThemeProvider>
  </StrictMode>,
);
