-- Stage 27, the sellable behaviour (ADR 0435): what a paid order line granted.
--
-- When an order is first paid (the move to `paid`, or to `part_paid` for a deposit), the host
-- creates one record of the line's declared granted object per unit (a ticket per place), in the
-- batch that makes the move, and one row here for each. The row is how the host finds them again
-- (to void them when the order is refunded in full or cancelled) and, when the grant asks for a
-- code, how a code is kept unique across every granted record and found by its code.
--
-- Only the move hook in packages/core/src/orders/grants.ts writes here.
CREATE TABLE core_order_grant (
  -- The granted record: its object's registry name and its id.
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  order_id TEXT NOT NULL REFERENCES core_order (id) ON DELETE CASCADE,
  line_id TEXT NOT NULL REFERENCES core_order_line (id) ON DELETE CASCADE,
  -- The host's unguessable code, when the grant declares one. Two equal codes fail the batch.
  code TEXT UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (object_type, record_id)
);
CREATE INDEX core_order_grant_order_idx ON core_order_grant (order_id);
