-- When the device last saw keyboard or mouse input, as its latest heartbeat reported it
-- (receive-device-health "A heartbeat may carry the time since the last input"). NULL when the
-- latest heartbeat did not say: presence then falls back to activity buckets (employee-directory).
ALTER TABLE devices ADD COLUMN last_input_at timestamptz;
