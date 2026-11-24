-- Migration 1273: what keeps a time entry for a person, and why it was reopened (stage 58 step 2,
-- ADR 0851).
--
-- `held`: the host never approves the entry on a match with the roster. 'person' when no one but
-- an approver should take its times on trust (an approver entered it for someone; its person
-- entered a finish the host had marked missing); 'approver' once an approver has sent it back or
-- reopened it, which also stops its person withdrawing it (and entering the same times again for
-- the host to approve). Never cleared: an approver decides the entry from then on.
--
-- `reopened_why`: why an approver reopened an approved entry, kept on it for the person and the
-- approvers to read (never in the audit log, a notice or an error) until it is approved or sent
-- back again.
--
-- Migration 1272 is stage 58 step 3's (pay), numbered by the spec before this step.
ALTER TABLE core_time_entry ADD COLUMN held TEXT CHECK (held IS NULL OR held IN ('person', 'approver'));
ALTER TABLE core_time_entry ADD COLUMN reopened_why TEXT
  CHECK (reopened_why IS NULL OR length(reopened_why) <= 500);

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1273'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1273;
