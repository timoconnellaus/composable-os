-- Migration 0600: extension tools queued before the dry-run fix (ADR 0022 amendment, 2026-11-22).
--
-- Until this release the approval queue's dry run ran an extension tool's code, and the tool's own
-- operation calls and storage writes were real: a tool still waiting for approval may already have
-- made its changes, and approving it would make them a second time. From this release a tool is
-- not run until it is approved, and the code that queues it says so on the action
-- (`simulated.notRun`). So the mark goes only on pending tool actions without that: queued by the
-- old code. Deploy order does not matter. If the new Workers are live before this runs, the
-- actions they queue carry `notRun` and are not marked; an action the old Workers queue after it
-- ran (during a rollout) is not marked either, which errs towards saying nothing over saying
-- something false. The Approvals inbox then says a marked tool's changes may already have been
-- made, that approving would repeat them, and recommends rejecting it. Nothing is rejected here:
-- a person decides.
UPDATE core_pending_action
SET simulated = json_set(COALESCE(NULLIF(simulated, ''), '{}'), '$.toolRanAtQueue', json('true'))
WHERE status = 'pending'
  AND operation LIKE 'x.%'
  AND json_extract(COALESCE(NULLIF(simulated, ''), '{}'), '$.notRun') IS NULL;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '600'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 600;
