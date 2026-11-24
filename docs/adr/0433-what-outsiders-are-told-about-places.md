# ADR 0433: What customers and the public are told about places

Status: accepted, 2026-11-21 (stage 26, build step 6). Opens `capacity.get` to customers and the
public (ADR 0402: a reviewed change, in `packages/core/open-operations.json`).

## Context
A buyer has to see whether a ticket type is on sale before they start an order. How much they are
told is the seller's choice: some show the exact number left, some say "only 3 left", some only
"sold out". Staff always see the real numbers.

## Decision
- **Each object declares `show`:** `exact` (the number left), `low` (available, `low` with the
  number at or below `lowAt`, or sold out) or `availability` (available or sold out, the
  default).
- **`capacity.get { object, id }`** (risk `read`, audiences staff, customer and public) answers
  through `ctx.records.capacity`, the visibility seam's new door
  (`packages/core/src/visibility/capacity.ts`). Staff get places, held, taken, available, `show`
  and the pool's numbers. A customer or the public get `{ object, id, status }`, plus `available`
  when `show` is `exact`, or `low` and the status is `low`. Never held, taken or the pool's numbers.
  `available` is the fewer of the record's and its pool's places left.
- **Capacity is its own scope.** A ticket type is not a customer's record, so the record seam
  shows them nothing of it. Any live record of an object that declares a capacity can be asked
  about by id; a record in Trash, or an object without a capacity, is not found.
- **The record page shows a Places panel** on objects that declare a capacity
  (`apps/app/src/components/record/capacity-card.tsx`).

## Consequences
- Anyone with a record's id can learn whether it is sold out. Ids are unguessable, and nothing
  else about the record is shown. When stage 28's `publishable` exists, outside callers should be
  limited to published records as well.
- `test/capacity-behaviour.test.ts` (criterion 8) fails if the filtering is removed.

## Amendment, 2026-11-21 (stage 27, ADR 0438)
A customer or the public is now told about the places of a record they may read only: their own,
or one public through its object's `public` declaration (an on-sale event's ticket type). Any
other record is not found. This is the narrowing this ADR said would follow once such a notion
existed. See [ADR 0438](0438-the-public-scope.md).

## Amendment, 2026-11-24 (stage 37, ADR 0682)
Stock follows the same rule through `stock.get`: staff see on hand, held and available; a customer
or the public, only for a record they may read, see what the object's `stock.show` allows
(`availability` by default: in stock or sold out; `low`: "only N left" at or below `lowAt`;
`exact`: the number available), never on hand, held or a movement. A refused order of goods tells
an outside caller "Sold out" or "Not enough in stock" and no number. See
[ADR 0682](0682-the-stock-behaviour.md).
