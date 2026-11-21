# ADR 0431: The capacity declaration, and the counter the record operations keep

Status: accepted, 2026-11-21 (stage 26, build steps 2 and 6). Builds on
[ADR 0430](0430-capacity-is-refused-by-the-database.md).

## Context
ADR 0430 put the rule in the database: a counter row per record, and claims that the database
refuses past the places. Something has to create those counters and keep them true, for every
actor, and an extension has to be able to say which of its objects have places.

## Decision
- **An object declares `capacity: { places, pool?, show?, lowAt?, releaseOnRefund? }`**
  (`CapacitySpec`, `packages/sdk/src/capacity.ts`). `places` is one of its number fields; empty is
  unlimited. `pool` is a relation (one record) to another of the extension's own objects, which
  must itself declare a capacity and no pool: one level only, checked by `extension.check`.
  `show` is ADR 0433's. `releaseOnRefund` (default true) is read by the order wiring (stage 25).
  It is additive and optional, so the contract version does not change.
- **The record operations keep the counter in the write's batch.** `record.create` and the record
  CSV import (which shares `createRecord`) insert it after the record, with its pool;
  `record.update` upserts it when places or the pool field change. Places must be a whole number
  from 0. Lowering below `held + taken` is refused by the database's trigger, with
  `{ rule: "capacity", object, record, places, held, taken }`, for every actor. No permission sells
  beyond the limit: raising places is the only way to let one more in, and it is audited like any
  other change.
- **The reconciler gives a counter to every record that has none** when it reconciles an object
  with a capacity (records made before the declaration, seeds), pools first. Existing counters are
  left alone. When a hidden object's table is dropped, its counters and claims go in the same
  batch; a record that drew on it as a pool is left without one (`ON DELETE SET NULL`).
- **Read-only values on the record: `held`, `taken`, `available`.** The object's `rec_x_*` view
  joins its counter and its pool's counter by primary key; `available` is the fewer of the
  record's and the pool's places left, null when both are unlimited. They are registry fields with
  no extension, so they are filterable and sortable, never writable, and never visible to a
  customer (the customer scope lists declared fields only). An object with a capacity cannot have
  fields with those names.
- **Trash:** `record.delete` refuses a record with places taken by paid orders. Trash releases
  nothing by itself: held claims stay held until what they were taken for releases them.
  Extension records are not purged today; when they are, the counter and claims go in the purge's
  batch.
- **Views for query.sql and dashboards:** `rec_capacity` (with `available` and `pool_available`)
  and `rec_capacity_claim` (migration 0441).

## Consequences
- Moving a record to another pool leaves its existing claims on the pool they drew on (copied onto
  each claim), so releasing them returns places to that pool. New claims draw on the new one.
- Removing `capacity` from an object leaves its counters and claims in place, unused.
- The trash refusal reads the counter before the write: a payment confirmed at the same moment
  could slip in between. The read is by primary key and the window is small; a refusal in the
  batch itself would need another trigger and was not worth it here.
