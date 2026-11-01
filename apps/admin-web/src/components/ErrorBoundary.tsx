import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props { children: ReactNode; /** change this (e.g. the pathname) to clear a previous error */ resetKey?: string; fullPage?: boolean }
interface State { error: Error | null }

/** A render error used to unmount the whole app (a blank page). Now it stays inside the page area with a way out. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };
  static getDerivedStateFromError(error: Error): State { return { error }; }
  override componentDidCatch(error: Error, info: ErrorInfo) { console.error("render error", error, info.componentStack); }
  override componentDidUpdate(prev: Props) { if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null }); }
  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const chunk = /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported/i.test(error.message);
    return (
      <div role="alert" className={this.props.fullPage ? "grid min-h-full place-items-center bg-background p-6" : "grid place-items-center py-16"}>
        <div className="max-w-md text-center">
          <span className="mx-auto mb-4 grid size-12 place-items-center rounded-2xl bg-destructive/10 text-destructive"><TriangleAlert className="size-6" /></span>
          <h2 className="font-display text-lg font-semibold">{chunk ? "A new version is available" : "This page hit a problem"}</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {chunk ? "Reload to get the latest version. Your data is safe." : "Nothing was lost. Try again, or go back and open it from the menu."}
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <Button onClick={() => (chunk ? location.reload() : this.setState({ error: null }))}><RefreshCw />{chunk ? "Reload" : "Try again"}</Button>
            <Button variant="outline" onClick={() => history.back()}>Go back</Button>
          </div>
        </div>
      </div>
    );
  }
}

export function PageSkeleton() {
  return (
    <div role="status" aria-live="polite" className="space-y-4 py-2">
      <span className="sr-only">Loading…</span>
      <div className="skeleton h-9 w-48" /><div className="skeleton h-4 w-80 max-w-full" />
      <div className="skeleton mt-6 h-40 w-full" /><div className="skeleton h-40 w-full" />
    </div>
  );
}
