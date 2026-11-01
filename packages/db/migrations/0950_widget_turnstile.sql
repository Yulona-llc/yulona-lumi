-- Wave 5 B: customizable Cloudflare Turnstile per widget.
-- The public site key and display options live in widgets.config.protection; the secret is write-only and stored
-- encrypted (AES-GCM, AAD "widget-turnstile:{tenant}:{widget}"), never returned by any API.
ALTER TABLE widgets ADD COLUMN IF NOT EXISTS turnstile_secret_enc text;
