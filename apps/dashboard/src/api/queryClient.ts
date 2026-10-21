import { MutationCache, QueryClient } from "@tanstack/react-query";
import { ApiError } from "./client";

/**
 * One QueryClient for the app. After ANY successful mutation every query is refreshed (active ones refetch now, the
 * rest are marked stale) and the mutation's own onSuccess (toast, close dialog) waits for that, so the UI never shows
 * pre-save data. Opt out with `meta: { skipInvalidate: true }` for optimistic flows that manage their own cache.
 */
export function createQueryClient(): QueryClient {
  const qc: QueryClient = new QueryClient({
    mutationCache: new MutationCache({
      onSuccess: async (_d, _v, _c, mutation) => {
        if (mutation.meta?.skipInvalidate) return;
        await qc.invalidateQueries();
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
      },
    },
  });
  return qc;
}
