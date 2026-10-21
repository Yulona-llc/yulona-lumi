import { describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { createQueryClient } from "@/api/queryClient";
import { keys } from "@/api/keys";
import { ErrorBoundary } from "@/components/ErrorBoundary";

describe("query keys", () => {
  test("a key never carries two data shapes: the inbox variant is distinct but still invalidated by the ['users'] prefix", () => {
    expect(keys.usersInbox).not.toEqual(keys.users);
    expect(keys.usersInbox.slice(0, 1)).toEqual(keys.users);
  });
});

describe("ErrorBoundary", () => {
  test("a render error stays inside the page area with a way out, and clears when the route changes", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const Bomb = ({ on }: { on: boolean }) => { if (on) throw new Error("boom"); return <p>fine</p>; };
    const { rerender } = render(<ErrorBoundary resetKey="/a"><Bomb on /></ErrorBoundary>);
    expect(screen.getByRole("alert")).toHaveTextContent("This page hit a problem");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    rerender(<ErrorBoundary resetKey="/b"><Bomb on={false} /></ErrorBoundary>);
    expect(screen.getByText("fine")).toBeInTheDocument();
    err.mockRestore();
  });
  test("a stale-chunk failure explains it and offers a reload", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const Bomb = () => { throw new Error("Failed to fetch dynamically imported module: /assets/x.js"); };
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    expect(screen.getByText("A new version is available")).toBeInTheDocument();
    err.mockRestore();
  });
});

describe("saves show up immediately", () => {
  test("every active query is refetched before the mutation's onSuccess runs", async () => {
    let server = "old";
    const qc = createQueryClient();
    const seenInOnSuccess: string[] = [];
    function Page() {
      const q = useQuery({ queryKey: ["thing"], queryFn: async () => server });
      const other = useQuery({ queryKey: ["overview", "thing"], queryFn: async () => `o-${server}` });
      const m = useMutation({ mutationFn: async () => { server = "new"; }, onSuccess: () => { seenInOnSuccess.push(`${qc.getQueryData(["thing"])}|${qc.getQueryData(["overview", "thing"])}`); } });
      return <div><p data-testid="v">{q.data}</p><p data-testid="o">{other.data}</p><button onClick={() => m.mutate()}>save</button></div>;
    }
    render(<QueryClientProvider client={qc}><Page /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("v")).toHaveTextContent("old"));
    await userEvent.click(screen.getByText("save"));
    await waitFor(() => expect(screen.getByTestId("v")).toHaveTextContent("new"));
    expect(screen.getByTestId("o")).toHaveTextContent("o-new"); // other features' queries too (e.g. Overview)
    expect(seenInOnSuccess).toEqual(["new|o-new"]);
  });
  test("skipInvalidate opts out", async () => {
    let n = 0;
    const qc = createQueryClient();
    function Page() {
      const q = useQuery({ queryKey: ["t"], queryFn: async () => ++n });
      const m = useMutation({ mutationFn: async () => 1, meta: { skipInvalidate: true } });
      return <div><p data-testid="v">{q.data}</p><button onClick={() => m.mutate()}>go</button></div>;
    }
    render(<QueryClientProvider client={qc}><Page /></QueryClientProvider>);
    await waitFor(() => expect(screen.getByTestId("v")).toHaveTextContent("1"));
    await userEvent.click(screen.getByText("go"));
    await new Promise((r) => setTimeout(r, 50));
    expect(n).toBe(1);
  });
});
