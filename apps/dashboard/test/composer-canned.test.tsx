import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import Composer from "../src/features/inbox/Composer";

function mount(handler: "ai" | "human") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><Composer conversationId="c1" handler={handler} onSend={vi.fn()} /></QueryClientProvider>);
}

describe("canned responses in the composer", () => {
  it("still works after Settings > Canned responses cached the list in its own shape", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(["canned"], [{ id: "x", shortcut: "hi", title: "Hello", content: "Hello from settings" }]); // what CannedPage stores
    render(<QueryClientProvider client={qc}><Composer conversationId="c1" handler="ai" onSend={vi.fn()} /></QueryClientProvider>);
    await userEvent.click(screen.getByRole("button", { name: /canned responses/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /greeting/i }));
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toMatch(/Thanks for reaching out/);
  });

  for (const handler of ["ai", "human"] as const) {
    it(`inserts a saved reply while the ${handler} handles the chat`, async () => {
      mount(handler);
      await userEvent.click(screen.getByRole("button", { name: /canned responses/i }));
      await userEvent.click(await screen.findByRole("menuitem", { name: /greeting/i }));
      expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toMatch(/Thanks for reaching out/);
    });
  }
});
