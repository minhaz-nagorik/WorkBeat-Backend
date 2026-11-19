-- WorkBeat backend — optional screenshot thumbnails (ingest-activity screenshot-upload, 19 Nov 2026).
-- thumb_bytes is set when the agent announced a thumbnail at {storage_path minus .jpg}.thumb.jpg;
-- cleared at confirmation when that object is missing or the wrong size. Null: tiles load the full image.
-- Self-check: db/tests/0011_screenshot_thumbnails_test.sql.

BEGIN;

ALTER TABLE screenshots ADD COLUMN thumb_bytes int CHECK (thumb_bytes > 0);

COMMIT;
