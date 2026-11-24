-- Migration 0816: checklists on their own, without a roster (ADR 0651; a follow-on to stage 45
-- step 4b, ADR 0650).
--
-- A checklist template may now have a standing schedule of its own: the days of the week it is
-- due (in the business's time zone), a time it is due by, and who may do it: everyone on staff,
-- the people holding a role (a pack role too: a cleaner, a coach), or the people granted a
-- permission. Each due day gets one run (`object_type` 'checklist.day', `record_id`
-- '<checklist id>:<YYYY-MM-DD>', so the run table's own one-per-record rule makes it one a day),
-- open from the start of that local day to the start of the next. Anyone who may do it ticks it;
-- whoever ticks the last step finishes it; one not finished by the end of its day is closed by the
-- host as missed. Everything migration 0815 holds for a run (a closed run never changes, ticks are
-- insert-only, done only once every required step is ticked) holds for these too.
--
-- **Only someone allowed ticks**, for every writer: a day run copies who may do it from its
-- template when it is made (`doers_kind`, `doers_value`, fixed from then on), and the triggers
-- below refuse a tick for anyone else, a tick on someone's behalf by anyone who does not manage
-- checklists (an admin, or an account granted checklists:write), and a finish by anyone else.

-- The template's schedule. `days` is a JSON array of ISO weekdays (1 Monday … 7 Sunday), or null:
-- no schedule (a duty's checklist only, as before). `due_by` is a local time (HH:MM), or null.
ALTER TABLE core_checklist ADD COLUMN days TEXT
  CHECK (days IS NULL OR (json_valid(days) AND json_type(days) = 'array'
    AND json_array_length(days) BETWEEN 1 AND 7));
ALTER TABLE core_checklist ADD COLUMN due_by TEXT
  CHECK (due_by IS NULL OR (length(due_by) = 5 AND due_by GLOB '[0-2][0-9]:[0-5][0-9]'));
-- Who may do it: 'staff' (every staff account that may write), 'role' (an account with the role
-- or pack role `doers_value`), 'grant' (an account granted the permission `doers_value`).
ALTER TABLE core_checklist ADD COLUMN doers_kind TEXT
  CHECK (doers_kind IS NULL OR doers_kind IN ('staff', 'role', 'grant'));
ALTER TABLE core_checklist ADD COLUMN doers_value TEXT
  CHECK (doers_value IS NULL OR length(doers_value) BETWEEN 1 AND 81);

-- A day run's copy of who may do it and when it is due by (unix seconds). Null on a record's run.
ALTER TABLE core_checklist_run ADD COLUMN doers_kind TEXT
  CHECK (doers_kind IS NULL OR doers_kind IN ('staff', 'role', 'grant'));
ALTER TABLE core_checklist_run ADD COLUMN doers_value TEXT;
ALTER TABLE core_checklist_run ADD COLUMN due_at INTEGER;

-- A day run is inserted with who may do it, and a record's run without.
CREATE TRIGGER core_checklist_day_run_insert
BEFORE INSERT ON core_checklist_run
BEGIN
  SELECT RAISE(ABORT, 'core_checklist_fixed')
  WHERE (NEW.object_type = 'checklist.day') != (NEW.doers_kind IS NOT NULL)
    OR (NEW.doers_kind = 'staff' AND NEW.doers_value IS NOT NULL)
    OR (NEW.doers_kind IN ('role', 'grant') AND NEW.doers_value IS NULL)
    OR (NEW.object_type != 'checklist.day' AND NEW.due_at IS NOT NULL)
    OR (NEW.object_type = 'checklist.day' AND NEW.account_id IS NOT NULL);
END;

-- Who may do a day run, who manages checklists, and what of a day run never changes. Its day,
-- who may do it and when it is due are fixed; while open it is nobody's own (no account); it is
-- finished by someone who may do it, for themselves, or by someone who manages checklists for
-- someone who may, with why.
CREATE TRIGGER core_checklist_day_run_update
BEFORE UPDATE ON core_checklist_run
WHEN OLD.object_type = 'checklist.day'
BEGIN
  -- A closed run never changes (as migration 0815's own trigger says, whichever fires first).
  SELECT RAISE(ABORT, 'core_checklist_closed') WHERE OLD.state != 'open';
  SELECT RAISE(ABORT, 'core_checklist_fixed')
  WHERE NEW.doers_kind IS NOT OLD.doers_kind OR NEW.doers_value IS NOT OLD.doers_value
    OR NEW.due_at IS NOT OLD.due_at OR NEW.opens IS NOT OLD.opens OR NEW.closes IS NOT OLD.closes
    OR NEW.ended_at IS NOT NULL OR NEW.ended_by IS NOT NULL
    OR (NEW.state = 'open' AND NEW.account_id IS NOT NULL)
    OR NEW.state = 'cancelled';
  SELECT RAISE(ABORT, 'core_checklist_not_allowed')
  WHERE NEW.state = 'done' AND NOT (
    -- Someone who may do it, finishing it themselves.
    (NEW.account_id = NEW.closed_by AND NEW.closed_why IS NULL AND EXISTS (
      SELECT 1 FROM core_user u WHERE u.id = NEW.closed_by AND u.kind = 'human'
        AND u.deactivated_at IS NULL AND u.support_grant_id IS NULL
        AND (u.pack_role IS NOT NULL OR u.role != 'viewer')
        AND (OLD.doers_kind = 'staff'
          OR (OLD.doers_kind = 'role' AND (u.pack_role = OLD.doers_value
            OR (u.pack_role IS NULL AND u.role = OLD.doers_value)))
          OR (OLD.doers_kind = 'grant' AND json_valid(u.granted_permissions) AND EXISTS (
            SELECT 1 FROM json_each(u.granted_permissions) g WHERE g.value = OLD.doers_value)))))
    -- Someone who manages checklists, for someone who may do it, with why.
    OR (NEW.account_id IS NOT NEW.closed_by AND NEW.closed_why IS NOT NULL
      AND EXISTS (SELECT 1 FROM core_user m WHERE m.id = NEW.closed_by AND m.kind = 'human'
        AND m.deactivated_at IS NULL AND m.pack_role IS NULL
        AND (m.role = 'admin' OR (json_valid(m.granted_permissions) AND EXISTS (
          SELECT 1 FROM json_each(m.granted_permissions) g WHERE g.value = 'checklists:write'))))
      AND EXISTS (SELECT 1 FROM core_user u WHERE u.id = NEW.account_id AND u.kind = 'human'
        AND u.deactivated_at IS NULL AND u.support_grant_id IS NULL
        AND (u.pack_role IS NOT NULL OR u.role != 'viewer')
        AND (OLD.doers_kind = 'staff'
          OR (OLD.doers_kind = 'role' AND (u.pack_role = OLD.doers_value
            OR (u.pack_role IS NULL AND u.role = OLD.doers_value)))
          OR (OLD.doers_kind = 'grant' AND json_valid(u.granted_permissions) AND EXISTS (
            SELECT 1 FROM json_each(u.granted_permissions) g WHERE g.value = OLD.doers_value)))))
  );
END;

-- A day run's tick is for someone who may do it, made by them, or for them by someone who
-- manages checklists.
CREATE TRIGGER core_checklist_day_tick_insert
BEFORE INSERT ON core_checklist_tick
WHEN EXISTS (SELECT 1 FROM core_checklist_run r WHERE r.id = NEW.run_id
  AND r.object_type = 'checklist.day')
BEGIN
  SELECT RAISE(ABORT, 'core_checklist_not_allowed')
  WHERE NOT EXISTS (
    SELECT 1 FROM core_checklist_run r JOIN core_user u ON u.id = NEW.ticked_for
    WHERE r.id = NEW.run_id AND u.kind = 'human' AND u.deactivated_at IS NULL
      AND u.support_grant_id IS NULL AND (u.pack_role IS NOT NULL OR u.role != 'viewer')
      AND (r.doers_kind = 'staff'
        OR (r.doers_kind = 'role' AND (u.pack_role = r.doers_value
          OR (u.pack_role IS NULL AND u.role = r.doers_value)))
        OR (r.doers_kind = 'grant' AND json_valid(u.granted_permissions) AND EXISTS (
          SELECT 1 FROM json_each(u.granted_permissions) g WHERE g.value = r.doers_value))))
    OR (NEW.on_behalf = 1 AND NOT EXISTS (
      SELECT 1 FROM core_user m WHERE m.id = NEW.ticked_by AND m.kind = 'human'
        AND m.deactivated_at IS NULL AND m.pack_role IS NULL
        AND (m.role = 'admin' OR (json_valid(m.granted_permissions) AND EXISTS (
          SELECT 1 FROM json_each(m.granted_permissions) g WHERE g.value = 'checklists:write')))));
END;

-- The schedules the minute cron reads: the active templates that have one.
CREATE INDEX core_checklist_scheduled ON core_checklist (active) WHERE days IS NOT NULL;
