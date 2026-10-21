/** API-key scopes accepted by the backend (bookings:* added with the public bookings endpoints). */
export const API_KEY_SCOPES = [
  "conversations:read", "conversations:write", "contacts:read", "contacts:write",
  "bookings:read", "bookings:write", "knowledge:read", "knowledge:write",
] as const;

/** Plain-language grouping for the scope picker. Every scope in API_KEY_SCOPES appears exactly once. */
export const SCOPE_GROUPS: Array<{ resource: string; label: string; hint: string }> = [
  { resource: "conversations", label: "Conversations", hint: "Messages and threads" },
  { resource: "contacts", label: "Contacts", hint: "People and their details" },
  { resource: "bookings", label: "Bookings", hint: "Appointments and reservations" },
  { resource: "knowledge", label: "Knowledge", hint: "Sources your agent answers from" },
];
