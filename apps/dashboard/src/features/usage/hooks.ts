import { useQuery } from "@tanstack/react-query";
import { creditKeys, creditsApi } from "./api";

/** Credits for the signed-in workspace (any role). `data` is null when the server has no credit info. */
export function useCredits(opts: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: creditKeys.credits, queryFn: creditsApi.credits, retry: false,
    refetchInterval: opts.poll ? 60_000 : false,
  });
}
