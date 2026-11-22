-- Migration 0690: drop-ins (stage 31a step 8, ADR 0560): a refund the host owes, and a cap on the
-- unpaid places a class may have held for it.
--
-- 1. A refund owed. A record bought through `sellable.moves` (a drop-in booking) whose order was
-- paid, entering one of its refund states (an in-time cancel, a class the gym cancels), or paid
-- for after its place went back (a late payment), owes the buyer their money. The move's own
-- batch writes one row here: the record and its order. Nothing is asked of the payment provider
-- in that batch: the minute cron asks the payments gatekeeper afterwards (`order.refundDue`), as
-- the outbound action `payments.refund`, always reviewed and approved only by a person with
-- `orders:refund`.
--
-- One row per order. `state`: `due` (written by the move); `asking` (the cron claimed it, in its
-- own statement, before it calls the gatekeeper); `asked` (refunds wait in Approvals; their ids
-- are `rfd_<this row's id>_<attempt>_<n>`, the provider's idempotency key); `done` (the order is
-- refunded); `lapsed` (every approval asked for was rejected or expired: staff are told once and
-- re-ask from the order); `skipped` (nothing could be asked, or the cron could not ask: `note`
-- says why, and staff were told).
CREATE TABLE core_sellable_refund_due (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES core_order (id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- The state the record entered (or `late`, a payment after its place went back), and why in
  -- staff's words.
  entered TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'due'
    CHECK (state IN ('due', 'asking', 'asked', 'done', 'lapsed', 'skipped')),
  attempt INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The cron's reads: what is due, being asked, or waiting for a person, oldest first.
CREATE INDEX core_sellable_refund_due_state_idx ON core_sellable_refund_due (state, created_at);

-- 2. A cap on unpaid holds. A guest's drop-in holds a place while its order is unpaid; a class may
-- carry at most `expected` such holds (unpaid drop-ins, not the waiting list's) at once, worked out
-- by the host from the class's places and the extension's setting. Kind 'held_cap' counts the held
-- claims on the record after the new one; more than `expected` fails the batch
-- (`core_holds_capped`). core_write_guard stores nothing, so it is made again with the new kind,
-- as migrations 0560, 0610 and 0670 did.
DROP TRIGGER core_write_guard_check;
DROP TABLE core_write_guard;

CREATE TABLE core_write_guard (
  kind TEXT NOT NULL
    CHECK (kind IN ('claimed', 'claimant', 'series', 'full', 'unmoved', 'held_cap')),
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  expected INTEGER NOT NULL
);

CREATE TRIGGER core_write_guard_check
BEFORE INSERT ON core_write_guard
BEGIN
  SELECT CASE
    WHEN NEW.kind = 'claimed' AND coalesce((SELECT held + taken FROM core_capacity
        WHERE object_type = NEW.object_type AND record_id = NEW.record_id), 0) != NEW.expected
      THEN RAISE(ABORT, 'core_recurrence_stale')
    WHEN NEW.kind = 'series' AND coalesce((SELECT version FROM core_recurrence_series
        WHERE object_type = NEW.object_type AND record_id = NEW.record_id), 0) != NEW.expected
      THEN RAISE(ABORT, 'core_recurrence_stale')
    WHEN NEW.kind = 'claimant' AND (SELECT count(*) FROM core_capacity_claim
        WHERE for_type = NEW.object_type AND for_id = NEW.record_id
          AND state IN ('held', 'confirmed')) != NEW.expected
      THEN RAISE(ABORT, 'core_claim_live')
    WHEN NEW.kind = 'full' AND NOT EXISTS (SELECT 1 FROM core_capacity
        WHERE object_type = NEW.object_type AND record_id = NEW.record_id
          AND places IS NOT NULL AND held + taken >= places)
      THEN RAISE(ABORT, 'core_waitlist_not_full')
    WHEN NEW.kind = 'unmoved' AND (SELECT count(*) FROM core_transition_history
        WHERE object_type = NEW.object_type AND record_id = NEW.record_id) != NEW.expected
      THEN RAISE(ABORT, 'core_moved_meanwhile')
    WHEN NEW.kind = 'held_cap' AND (SELECT count(*) FROM core_capacity_claim
        WHERE object_type = NEW.object_type AND record_id = NEW.record_id
          AND state = 'held' AND for_type != 'waitlist') > NEW.expected
      THEN RAISE(ABORT, 'core_holds_capped')
    ELSE RAISE(IGNORE)
  END;
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '690'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 690;
