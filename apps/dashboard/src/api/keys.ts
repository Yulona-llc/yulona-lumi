/**
 * Query keys. Rule: one key = one fetcher = one data shape. Two features that need the same endpoint in different
 * shapes get different keys (a shared key with two shapes crashed pages that rendered cached data of the other shape).
 * `["users"]` prefix invalidation still reaches every variant.
 */
export const keys = {
  /** `UserRow[]` (items unwrapped): team, tickets, attention */
  users: ["users"] as const,
  /** `{ items: [...] }` (raw): inbox assignee pickers */
  usersInbox: ["users", "inbox"] as const,
};
