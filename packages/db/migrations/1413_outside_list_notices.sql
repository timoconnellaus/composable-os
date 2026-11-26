-- Migration 1413: the notices a members list's age sends, each told once (stage 65 step 4,
-- ADR 0923).
--
-- The minute cron tells the holders of bookingSystem:manage when the current members list is 3
-- days from the largest age (`told_soon_at`) and when it passes it and stops counting for members'
-- prices and programs (`told_old_at`). Each is set in the batch that writes the notices, guarded by
-- `IS NULL`, so a list is told each thing once whatever the ticks do. A new list is a new row, so
-- it is told afresh. Times only: never a name or an address.
ALTER TABLE core_outside_list ADD COLUMN told_soon_at TEXT;
ALTER TABLE core_outside_list ADD COLUMN told_old_at TEXT;
