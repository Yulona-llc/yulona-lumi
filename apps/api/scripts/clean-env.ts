// Preloaded (`bun --preload dist/clean-env.js`) by the api/worker containers. docker compose passes every optional
// variable as an empty string when unset; treat those as "not set" so `?? default` and Zod `.optional()` behave.
for (const [k, v] of Object.entries(process.env)) if (v === "") delete process.env[k];
