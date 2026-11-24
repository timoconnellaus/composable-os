# ADR 0438: The public scope: what the public may read

Status: accepted, 2026-11-21 (stage 27, at review of steps 2 and 3). Builds on ADRs
[0402](0402-staff-and-customers.md), [0410](0410-the-seams-first-door-as-built.md),
[0412](0412-customer-scope-and-principals-as-built.md) and
[0414](0414-pack-tools-run-as-the-customer.md). Brings forward the "Public reads" part of stage
28, which `publishable` will extend. Amends [ADR 0433](0433-what-outsiders-are-told-about-places.md)
and [ADR 0435](0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md).

## Context
Ghetto's event page must show the events on sale and their ticket types to anyone, with no
account. After stage 22 the public could read nothing: the seam's scope for them was `none` on
every object, and no tool can fill that in. Stage 28 specced "an object declares which fields the
public may read" for published content; ticketing needs it first, for records that are public
while they are in a state (an event on sale), or while a record they point to is (a ticket type
while its event is on sale). Two gaps followed from it: `capacity.get` told anyone the places of
any record by id, and `order.start` let a guest buy a ticket type of an event that was still a
draft, given its id.

## Decision

**An object declares `public: { read, when? }`** (`PublicSpec` in the SDK; `PublicDeclaration`
in the field registry, carried by the reconciler as `customer` is):
- `read`: the object's own fields the public may read. `id` always.
- `when`: `{ field, in }`, a select field (a state) of the record and the values for which it is
  public; or `{ via, field, in }`, the same on the record that `via`, a single relation to
  another of the extension's objects, points to. Left out, every live record is public (a
  catalogue item).
- Deny by default: no declaration, nothing public. An object declares `customer` or `public`,
  never both.
- Only a shipped pack or an org's own extension may declare it. A runtime extension is refused by
  `extension.check` and install (`outside_audience`), as `customer` and `sellable` are.
  `cos ext check` prints what the public may read among the lines a reviewer reads.

**The seam enforces it** (`packages/core/src/visibility/public.ts`, `index.ts`). The public's
scope on an object is `public` when it declares one and `none` otherwise. `visibleSource` returns
`(SELECT id, <read columns> FROM rec_x WHERE <state column> IN (…))`, or with `via`
`WHERE <relation column> IN (SELECT id FROM rec_parent WHERE <state column> IN (…))`. A column
not listed is not in the source, so no filter, sort, field selection or error can reach it, and
a record that does not meet `when` is not in it: it is not found, exactly as one that does not
exist. `visibleObject` narrows the definition the same way, so a filter on an unlisted field fails
as an unknown field. The public's scope has no writes.

**A signed-in customer reads at least what the public may:** on an object that declares no
customer, a customer's scope is the public one.

**The public never calls generic record reads.** Two core operations, `public.list` and
`public.get`, are open to `customer` and `public`, risk `read`, and `toolOnly`: called directly
they are an unknown operation. A pack's tool open to the public calls them, as the caller
(ADR 0414); the seam, not the tool, decides rows and fields. They answer only for objects that
declare `public`. `my.list` and `my.get` stay a customer's own records only: an object without a
`customer` is unknown there, so a customer, too, reads public records only through a pack's tool.

**Places are told only of what the caller may read.** `capacity.get` for a customer or the public
answers for a record their scope shows them (their own, or a public one); any other is not found.
This is the narrowing ADR 0433 asked for.

**A customer or a guest buys only what they may read.** `priceLines`, which every way of
starting an order goes through, refuses a line whose record the buyer's scope does not show, with
the answer a record that does not exist gets (`not_for_sale`, "This cannot be bought"). Staff may
still start an order for anything sellable. So a ticket type of a draft event cannot be bought
from outside until the event is on sale.

**Stage 28.** `when` is the one place a record's being public is decided. `publishable` adds "has
a published version" as another kind of condition (and serves the published version's values),
in the same source; nothing else in the seam changes.

## Why
- The rule lives where every read already passes: rows and fields limited in the source itself,
  as for customers, so "the public sees only on-sale events and only the declared fields" is a
  property of one function and not of each tool.
- Tool-only reads keep the public's surface to what packs open on purpose, each one in
  `open-operations.json`.
- Buying through the read scope makes "what a guest may buy" and "what a guest may see" one
  decision, made by the object's declaration, with no rule in a tool.

## Proof
- `packages/core/test/isolation-suite.ts` gains public cases: two shows (one on sale, one draft)
  with a tier each, through a state of their own and through a relation. Every open operation is
  called as the public and as a customer with hostile inputs aimed at both. No response holds a
  value of the draft show or its tier, or an unlisted field (the backstage note, the cost), and an
  id of a hidden record answers as a guessed one. Every operation not open to a caller, and every
  tool-only one called directly, is unknown. With the `when` filter removed the suite finds 34
  leaks; with the field list ignored, 59.
- `apps/runner/test/ticketing.test.ts` (criterion 9): the public and a customer see the on-sale
  event and not the draft one, its ticket types with their availability, and none of `places`,
  `held` or `taken`. `public.list` called directly and `my.list` on an event are refused.
  `capacity.get` on a draft event's ticket type is not found. A guest's and a customer's order
  for a draft event's ticket type is refused exactly as one for an id that does not exist; staff's
  is not.
- `packages/core/test/public-scope.test.ts`: the declaration's checks, and the runtime refusal.

## Consequences
- An object that is sold to customers or the public must declare what they may read. The test
  fixtures that sell (the box office, the shop's items) now do.
- One subquery per read of an object public through `via`. The state field should be indexed on
  the parent (Ticketing indexes the event's status).
- `public.list` and `public.get` are in `open-operations.json` and the API contract, marked
  `toolOnly`.

## Amendment, 2026-11-21 (stage 41, ADR 0447)
An object may also declare `signedIn`, the same shape, read by every signed-in customer and never
the public. `my.list` and `my.get` now answer for an object that declares a customer or
`signedIn`: records shared with every signed-in customer are declared for them on purpose, as
their own are. `public.*` stays for what the public may read. An object declares `public` or
`signedIn`, not both. See [ADR 0447](0447-the-signed-in-scope.md).

## Amended 2026-11-21 (ADR 0439)
- `my.list` and `my.get` also answer for an object that declares `customerVia`: a customer reads
  there the records their own records point to and, on an object that is public too, the public
  ones beside them. On an object that declares only `public`, a customer still reads it only
  through a pack's tool.
- **Buying reads the scope without `customerVia`** (`buyableSource`): a customer or a guest buys
  only what they may read as their own or as the public, never what they read only through their
  own records.

## Amendment, 2026-11-22 (stage 28, ADR 0442)
On a publishable object the public scope's source is the object's live view: only records with a
current version, their content from that version. `when` holds beside it. Three content reads,
`content.get`, `content.list` and `content.preview`, are open to the public to call directly
(not `toolOnly`), each reading as the public whoever calls. See
[ADR 0442](0442-what-the-public-reads-of-content.md).

## Amendment, 2026-11-24 (stage 29, ADR 0720)
A form the public answers is read through the door (`intake.open`), which checks it takes answers
from the caller now, beside any public scope its pack declares; and the public answers it through
`intake.submit`. See [ADR 0720](0720-the-intake-door-one-public-write.md).
