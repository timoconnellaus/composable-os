-- Migration 1273: why an approved time entry was reopened (stage 58 step 2, ADR 0851).
--
-- An approver reopens an approved entry, saying why, while its pay period is open: it waits
-- again. The why is kept on the entry for the person and the approvers to read (never in the
-- audit log, a notice or an error), cleared when the entry is approved or rejected again. While
-- it is set the host never approves the entry on a match with the roster: an approver asked to
-- look at it. Migration 1272 is stage 58 step 3's (pay), numbered by the spec before this step.
ALTER TABLE core_time_entry ADD COLUMN reopened_why TEXT
  CHECK (reopened_why IS NULL OR length(reopened_why) <= 500);

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1273'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1273;
