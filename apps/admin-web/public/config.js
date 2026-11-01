// Runtime config. In containers this file is regenerated at start from API_URL and CUSTOMER_APP_URL.
// apiUrl empty = same origin (/api/v1 is proxied to admin-api by Caddy). In development point it at admin-api.
window.__ADMIN_CONFIG__ = window.__ADMIN_CONFIG__ || { apiUrl: "http://localhost:4100" };
