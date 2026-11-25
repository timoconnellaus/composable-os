-- Migration 0932: goods and delivery on orders (stage 37 step 3, ADR 0682).
--
-- An order with goods (a line of an object declaring `sellable.goods`) has a channel the host
-- works out from its delivery and never takes from a caller: `online` for a post or collect
-- delivery, `in_person` for "take it now". It is written when the order starts and never changes.
-- An order with no goods has none.
--
-- The order's delivery is one row here: the delivery line (a record of an object declaring
-- `sellable.delivery`), its kind and, for a post delivery, the address the goods go to. The
-- address is personal data kept by the host: it is in no rec_* view, export, dashboard or search,
-- and is read one order at a time (`order.delivery.get`). Erasing the buyer blanks it and marks
-- the row erased; nothing else changes a row.

ALTER TABLE core_order ADD COLUMN channel TEXT CHECK (channel IS NULL OR channel IN ('online', 'in_person'));

CREATE TRIGGER core_order_channel_fixed
BEFORE UPDATE OF channel ON core_order
WHEN NEW.channel IS NOT OLD.channel
BEGIN
  SELECT RAISE(ABORT, 'core_order_channel_fixed');
END;

CREATE TABLE core_order_delivery (
  order_id TEXT PRIMARY KEY REFERENCES core_order(id),
  -- The order's delivery line: the option chosen, priced by the host (ADR 0685).
  line_id TEXT NOT NULL UNIQUE REFERENCES core_order_line(id),
  kind TEXT NOT NULL CHECK (kind IN ('post', 'collect', 'here')),
  -- A post delivery's address; empty for collect and here, and once erased.
  name TEXT,
  line1 TEXT,
  line2 TEXT,
  city TEXT,
  region TEXT,
  postcode TEXT,
  -- ISO 3166-1 alpha-2, upper case.
  country TEXT CHECK (country IS NULL OR (length(country) = 2 AND country = upper(country))),
  created_at TEXT NOT NULL,
  -- When the buyer's erase blanked the address.
  erased_at TEXT,
  CHECK (kind = 'post' OR (name IS NULL AND line1 IS NULL AND line2 IS NULL AND city IS NULL
    AND region IS NULL AND postcode IS NULL AND country IS NULL)),
  CHECK (kind <> 'post' OR erased_at IS NOT NULL OR (name IS NOT NULL AND line1 IS NOT NULL
    AND country IS NOT NULL))
);

-- A delivery is written with its order and never changed, except by the buyer's erase, which
-- blanks every part of the address at once and says when.
CREATE TRIGGER core_order_delivery_fixed
BEFORE UPDATE ON core_order_delivery
WHEN NEW.order_id IS NOT OLD.order_id OR NEW.line_id IS NOT OLD.line_id
  OR NEW.kind IS NOT OLD.kind OR NEW.created_at IS NOT OLD.created_at
  OR OLD.erased_at IS NOT NULL OR NEW.erased_at IS NULL
  OR NEW.name IS NOT NULL OR NEW.line1 IS NOT NULL OR NEW.line2 IS NOT NULL
  OR NEW.city IS NOT NULL OR NEW.region IS NOT NULL OR NEW.postcode IS NOT NULL
  OR NEW.country IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'core_order_delivery_fixed');
END;

-- One delivery per order, written once: `INSERT OR REPLACE` would delete the row first without
-- firing a delete trigger (issue #269), so a second insert for the order or its line is refused.
CREATE TRIGGER core_order_delivery_once
BEFORE INSERT ON core_order_delivery
WHEN EXISTS (SELECT 1 FROM core_order_delivery
  WHERE order_id = NEW.order_id OR line_id = NEW.line_id)
BEGIN
  SELECT RAISE(ABORT, 'core_order_delivery_fixed');
END;

CREATE TRIGGER core_order_delivery_kept
BEFORE DELETE ON core_order_delivery
BEGIN
  SELECT RAISE(ABORT, 'core_order_delivery_kept');
END;

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '932'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 932;
