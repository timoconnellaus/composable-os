-- Migration 1153: the dates finance counts money on, indexed (stage 52 step 3, ADR 0796).
--
-- A month's day summaries, Sales, Tax and Refunds read the payments the host applied in it (by
-- `received_at`), the late payments staff honoured in it (by `resolved_at`) and the refunds the
-- provider confirmed in it (by `confirmed_at`). Without these indexes each read would scan every
-- payment and refund the business ever took; with them a month reads its own rows. Indexes only:
-- no column, no row and no trigger of the order tables changes. (1151 and 1152 are the spec's
-- for payouts and the subscription history, stage 52 steps 4 and 5.)
CREATE INDEX core_order_payment_received_idx ON core_order_payment (received_at)
  WHERE outcome = 'applied';
CREATE INDEX core_order_payment_honoured_idx ON core_order_payment (resolved_at)
  WHERE outcome = 'late' AND resolved = 'honoured';
CREATE INDEX core_order_refund_confirmed_idx ON core_order_refund (confirmed_at)
  WHERE status = 'confirmed';

-- Guarded: migrations land out of order (docs/parallel-work.md).
UPDATE core_meta SET value = '1153'
  WHERE key = 'schema_version' AND CAST(value AS INTEGER) < 1153;
