-- Migration 0690: a refund the host owes (stage 31a step 8, ADR 0560).
--
-- A record bought through `sellable.moves` (a drop-in booking) whose order is paid, entering one
-- of its refund states (an in-time cancel, a class the gym cancels), owes the buyer their money.
-- The move's own batch writes one row here: the record and its order. The money does not move
-- here, and nothing is asked of the payment provider in that batch: the minute cron asks the
-- payments gatekeeper for the refund afterwards (`order.refundDue`), which is the outbound action
-- `payments.refund`, always reviewed and approved only by a person with `orders:refund`.
--
-- One row per order: a second move into a refund state owes nothing more. `state` is `due`
-- (written by the move), `asking` (the cron took it: claimed in its own batch before it calls the
-- gatekeeper, so a crash never asks twice; staff are told of one left asking), `asked` (the
-- refunds are in core_order_refund, waiting for a person) or `skipped` (nothing could be
-- refunded: already refunded by staff, or never paid; `note` says why).
CREATE TABLE core_sellable_refund_due (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES core_order (id) ON DELETE CASCADE,
  object_type TEXT NOT NULL,
  record_id TEXT NOT NULL,
  -- The state the record entered, and why in staff's words (the class was cancelled).
  entered TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'due' CHECK (state IN ('due', 'asking', 'asked', 'skipped')),
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The cron's read: what is due, oldest first.
CREATE INDEX core_sellable_refund_due_state_idx ON core_sellable_refund_due (state, created_at);
