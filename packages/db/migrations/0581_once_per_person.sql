-- Migration 0581: things a Person may buy once (stage 32b, build step 6, ADR 0512).
--
-- An object whose `sellable.onePerPerson` names a boolean field (a pass type's "intro offer")
-- sells each Person one record, across every record of the object with the flag on. A row here is
-- that Person's one: written `held` in the batch that starts the order (only for a buyer who proved
-- who they are), `used` in the batch that first marks the order paid, and `released` only when
-- the order expires or is cancelled unpaid. The unique index refuses a second row that is held or
-- used, so two orders started at once give one: the second start's whole batch fails, and no
-- order exists for it. A late payment staff honour on an expired order takes it again, and is
-- refused the same way when the Person has had theirs since (staff refund instead).
CREATE TABLE core_sellable_once (
  id TEXT PRIMARY KEY NOT NULL,
  person_id TEXT NOT NULL REFERENCES core_person (id) ON DELETE CASCADE,
  -- The sellable object: one per Person across all of its records with the flag on.
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES core_order (id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('held', 'used', 'released')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX core_sellable_once_one
  ON core_sellable_once (person_id, object_type) WHERE state IN ('held', 'used');
CREATE INDEX core_sellable_once_order_idx ON core_sellable_once (order_id);

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '581'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 581;
