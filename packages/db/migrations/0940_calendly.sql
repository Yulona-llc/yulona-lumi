-- Wave 4 B4: Calendly as a second calendar provider.
-- calendar_connections: provider IN (google, calendly); at most one default provider per tenant (the one the AI uses).
-- For Calendly, `calendar_id` holds the chosen event type URI ('primary' until one is selected).
ALTER TABLE calendar_connections DROP CONSTRAINT IF EXISTS calendar_connections_provider_check;
ALTER TABLE calendar_connections ADD CONSTRAINT calendar_connections_provider_check CHECK (provider IN ('google','calendly'));
ALTER TABLE calendar_connections ADD COLUMN is_default boolean NOT NULL DEFAULT false;
UPDATE calendar_connections SET is_default = true;
CREATE UNIQUE INDEX calendar_connections_default_idx ON calendar_connections (tenant_id) WHERE is_default;

-- bookings: provider calendly; new status `offered` = a single-use Calendly scheduling link was sent (free plan / no invitee API).
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_provider_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_provider_check CHECK (provider IS NULL OR provider IN ('google','calendly'));
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check CHECK (status IN ('booked','cancelled','failed','offered'));
