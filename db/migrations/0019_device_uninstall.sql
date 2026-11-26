-- B36: an uninstall through the uninstaller is a release plus the fact that WorkBeat is gone.
-- POST /v1/agents/uninstall sets released_at (frees the seat, as a release does) and uninstalled_at,
-- and clears the key. deactivated_at stays unused (B35).
BEGIN;
ALTER TABLE devices ADD COLUMN uninstalled_at timestamptz;
ALTER TABLE devices ADD CONSTRAINT devices_uninstalled_is_released CHECK (uninstalled_at IS NULL OR released_at IS NOT NULL);
COMMIT;
