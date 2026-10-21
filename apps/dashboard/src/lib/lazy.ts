import { lazy, type ComponentType } from "react";

const FLAG = "yulona-chunk-reload";

/**
 * `lazy()` that survives a deploy: an open tab keeps asking for old hashed chunks that no longer exist, which used to
 * leave a blank page. On the first failed import we reload once (guarded in sessionStorage so it can never loop);
 * if it fails again the ErrorBoundary shows a "new version available" message.
 */
export function lazyWithReload<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      const m = await load();
      try { sessionStorage.removeItem(FLAG); } catch { /* ignore */ }
      return m;
    } catch (e) {
      let tried = false;
      try { tried = sessionStorage.getItem(FLAG) === "1"; sessionStorage.setItem(FLAG, "1"); } catch { /* ignore */ }
      if (!tried) { location.reload(); return new Promise<never>(() => {}); }
      throw e;
    }
  });
}
