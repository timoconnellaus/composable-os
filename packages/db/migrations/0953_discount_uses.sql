-- Migration 0953: the discount behaviour's uses (stage 34 step 4, ADR 0693).
--
-- A discount is a record of an object declaring `discount` (a pack's promo code or member's
-- price). The host works out an order's one deal when it prices the order (orders/orders.ts,
-- `priceOrder`) and writes it as `code` or `automatic` adjustments (migration 0950). Each order a
-- deal is on has one use here, on core_sellable_once's shape (ADR 0512):
--
--   - held from the order's start, in the batch that writes the order;
--   - used in the batch that first marks the order paid or part paid;
--   - released when the unpaid order expires or is cancelled, or when its code is changed or
--     taken off before it is paid. A refund keeps it used.
--
-- The limits are the discount record's (and its code record's), copied onto the use as the host
-- read them, so this trigger can refuse the use past them in the same batch: of two orders
-- started at once at the last use, one exists. `max_per_person` counts every Person sharing a
-- folded address with the use's (ADR 0692): `a+1@x` and `a+2@x` are one person. The expression is
-- migration 0955's, so its index serves it.
CREATE TABLE core_discount_use (
  id TEXT PRIMARY KEY,
  -- The discount record (its object's registry name and id), and the code record typed, if any.
  discount_object TEXT NOT NULL,
  discount_id TEXT NOT NULL,
  code_object TEXT,
  code_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('code', 'automatic')),
  -- The order's Person; null for a guest (who never gets a per-person discount).
  person_id TEXT,
  order_id TEXT NOT NULL REFERENCES core_order(id),
  state TEXT NOT NULL CHECK (state IN ('held', 'used', 'released')),
  -- What the deal took off the order, in minor units.
  amount INTEGER NOT NULL CHECK (amount > 0),
  -- The limits as the host read them at the hold; null: none.
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses >= 0),
  max_per_person INTEGER CHECK (max_per_person IS NULL OR max_per_person >= 0),
  code_max_uses INTEGER CHECK (code_max_uses IS NULL OR code_max_uses >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (max_per_person IS NULL OR person_id IS NOT NULL),
  CHECK ((code_object IS NULL) = (code_id IS NULL)),
  CHECK (code_max_uses IS NULL OR code_id IS NOT NULL)
);
CREATE INDEX core_discount_use_discount_idx
  ON core_discount_use (discount_object, discount_id, state);
CREATE INDEX core_discount_use_code_idx
  ON core_discount_use (code_object, code_id, state) WHERE code_id IS NOT NULL;
CREATE INDEX core_discount_use_order_idx ON core_discount_use (order_id);
CREATE INDEX core_discount_use_person_idx
  ON core_discount_use (person_id, discount_object, discount_id) WHERE person_id IS NOT NULL;

-- The limits, in the batch that holds the use.
CREATE TRIGGER core_discount_use_limit
BEFORE INSERT ON core_discount_use
WHEN NEW.state IN ('held', 'used') AND (
  (NEW.max_uses IS NOT NULL AND (
    SELECT count(*) FROM core_discount_use u
    WHERE u.discount_object = NEW.discount_object AND u.discount_id = NEW.discount_id
      AND u.state IN ('held', 'used')
  ) >= NEW.max_uses)
  OR (NEW.code_max_uses IS NOT NULL AND (
    SELECT count(*) FROM core_discount_use u
    WHERE u.code_object = NEW.code_object AND u.code_id = NEW.code_id
      AND u.state IN ('held', 'used')
  ) >= NEW.code_max_uses)
  OR (NEW.max_per_person IS NOT NULL AND (
    SELECT count(*) FROM core_discount_use u
    WHERE u.discount_object = NEW.discount_object AND u.discount_id = NEW.discount_id
      AND u.state IN ('held', 'used')
      AND u.person_id IN (
        SELECT NEW.person_id
        UNION
        SELECT theirs.person_id FROM core_person_emails mine
        JOIN core_person_emails theirs ON (
          CASE
            WHEN instr(theirs.email, '+') > 1 AND instr(theirs.email, '+') < instr(theirs.email, '@')
            THEN substr(theirs.email, 1, instr(theirs.email, '+') - 1)
              || substr(theirs.email, instr(theirs.email, '@'))
            ELSE theirs.email
          END
        ) = (
          CASE
            WHEN instr(mine.email, '+') > 1 AND instr(mine.email, '+') < instr(mine.email, '@')
            THEN substr(mine.email, 1, instr(mine.email, '+') - 1)
              || substr(mine.email, instr(mine.email, '@'))
            ELSE mine.email
          END
        )
        WHERE mine.person_id = NEW.person_id
      )
  ) >= NEW.max_per_person)
)
BEGIN
  SELECT RAISE(ABORT, 'core_discount_use_limit');
END;

-- A use moves once: held to used, or held to released. Nothing else about it changes, but its
-- Person (a merge moves it to the survivor). A use given back is a new row if it is taken again
-- (a late payment honoured), judged by the limits again.
CREATE TRIGGER core_discount_use_fixed
BEFORE UPDATE ON core_discount_use
WHEN NEW.id IS NOT OLD.id OR NEW.discount_object IS NOT OLD.discount_object
  OR NEW.discount_id IS NOT OLD.discount_id OR NEW.code_object IS NOT OLD.code_object
  OR NEW.code_id IS NOT OLD.code_id OR NEW.kind IS NOT OLD.kind
  OR NEW.order_id IS NOT OLD.order_id OR NEW.amount IS NOT OLD.amount
  OR NEW.max_uses IS NOT OLD.max_uses OR NEW.max_per_person IS NOT OLD.max_per_person
  OR NEW.code_max_uses IS NOT OLD.code_max_uses OR NEW.created_at IS NOT OLD.created_at
  OR (NEW.state IS NOT OLD.state AND NOT (OLD.state = 'held' AND NEW.state IN ('used', 'released')))
BEGIN
  SELECT RAISE(ABORT, 'core_discount_use_fixed');
END;

CREATE TRIGGER core_discount_use_kept
BEFORE DELETE ON core_discount_use
BEGIN
  SELECT RAISE(ABORT, 'core_discount_use_kept');
END;

-- A delivery's own price and its free-over amount as the host read them at the order's start
-- (ADR 0685), so a code put on the pending order later (order.applyCode) decides free postage
-- again on the goods' net after the deal (the spec's rule 8) from what the order was priced at.
ALTER TABLE core_order_delivery ADD COLUMN price INTEGER CHECK (price IS NULL OR price >= 0);
ALTER TABLE core_order_delivery ADD COLUMN free_over INTEGER
  CHECK (free_over IS NULL OR free_over >= 0);

-- Uses for reports: what each discount was used on, its order's state and currency.
CREATE VIEW rec_discount_use AS
SELECT
  u.id, u.discount_object, u.discount_id, u.code_object, u.code_id, u.kind, u.person_id,
  u.order_id, u.state, u.amount, u.created_at, u.updated_at,
  o.state AS order_state, o.currency, o.total AS order_total
FROM core_discount_use u
JOIN core_order o ON o.id = u.order_id;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '953'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 953;
