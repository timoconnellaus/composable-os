# ADR 0439: What a customer reads through their own records

Status: accepted, 2026-11-21 (stage 27 follow-up, from the first client's build). Builds on ADRs
[0402](0402-staff-and-customers.md), [0412](0412-customer-scope-and-principals-as-built.md),
[0414](0414-pack-tools-run-as-the-customer.md), [0438](0438-the-public-scope.md) and
[0447](0447-the-signed-in-scope.md). Amends ADR 0438 on `my.*` and on buying.

## Context
A ticket's holder reads their ticket (`customer: holder`) and through it two ids: its event and
its ticket type. Their names, dates and venue were meant to come from the client's own list of
events on sale. But a ticket is looked at most when its event is no longer on sale: the day of
the event (after sales close), or after it ended. Then the public scope (ADR 0438) no longer shows
the event, and the holder's ticket shows no name, date or venue. A tool cannot fix that by reading
the event as the extension: under ADR 0414 a tool called by a customer runs as the customer, and
the seam, not the tool, decides rows and fields.

Programs (stage 41) has the same shape: a member reads the exercises a program of theirs uses.

## Decision
**An object declares `customerVia: { from, field, read }`** (`CustomerViaSpec` in the SDK; the field
registry holds it as `customerVia`, carried by the reconciler as `public` is):
- `from`: another object of the same extension (`<extension>.<object>`) that declares a
  `customer` (the ticket).
- `field`: a single relation of `from` to this object (the ticket's `event`), one the `from`
  object's customer may read (`customer.read` lists it).
- `read`: fields of this object the customer may read.

A signed-in customer then sees a record of the object while **one of their own records of
`from` points to it through `field`**, and of it only the fields in `read`. Deny by default: no
declaration, nothing. An object that declares a `customer` cannot also declare it. Only a shipped
pack or an org's own extension may declare it (`outside_audience` for a runtime extension, as
for `customer`, `public`, `signedIn` and `sellable`); `cos ext check` prints it.

**The seam enforces it** (`packages/core/src/visibility/via.ts`, `index.ts`): a customer's scope on
such an object is the `via` scope, and its source is
`(SELECT id, <columns> FROM rec_x WHERE id IN (SELECT <field> FROM rec_<from> WHERE <customer> = :me))`.
"Their own records" are the `from` rows whose customer field is the caller's Person, exactly the
`from` object's own customer scope; the person id is a bound parameter. A column `read` does not
list is not in the source, so no filter, sort or error reaches it. Live: the source is the record
as it is now, so a changed date shows on the ticket, and a ticket no longer pointing at a record
no longer reads it.

**Beside `public` or `signedIn`.** An object may declare one of those as well (an event is public
while on sale). A customer then reads both: `WHERE <reached> OR <condition>`, and a column only one
declaration lists is `CASE WHEN <its condition> THEN col END`, as ADR 0447's shared columns are. So
a holder reads their ended event's declared fields, and an on-sale event they hold no ticket for
shows only the public's fields; a field only the holder's declaration lists is empty on it.

**`my.list` and `my.get`** answer for objects that declare `customerVia` too (ADR 0447 opened
them to `signedIn`). A tool reads a customer's records and then the records they point to:
Ticketing's `myTickets` lists the caller's tickets, then their events and ticket types with an
`id in [...]` filter, and the seam decides which of those the caller reads.

**Reading is not buying.** A customer or a guest buys only what they may read as their own or
as the public (ADR 0438), never what they read only through their own records: `priceLines` reads
the line's record through `buyableSource`, which is the caller's scope without `customerVia`. So
a holder still reads the ticket type of an ended event and cannot buy another.

## Why
- Declared on the record that is read (the event), because what of an event a holder may see is
  the event's to say, field by field; the ticket only says that it points there, and the
  declaration requires that the holder can see that pointer.
- The condition is a subquery over the customer's own rows, in the same source every read takes,
  so "only for records one of their own records points to" is a property of one function and not
  of a tool, and the stage 22 isolation suite tests it for every open operation.
- One relation, one object of the same extension: the least that serves a ticket's event and
  type and a program's exercises. Several `from` objects, or a path of relations, can be added to
  the declaration later without changing its meaning.

## Proof
- `packages/core/test/isolation-suite.ts`: each fixture customer has a ticket pointing at a show
  only they hold, not on sale, with a backstage note and doors. Every open operation called as A
  and as the public with B's ids and filters returns nothing of B's held show; A reads exactly the
  declared fields of their own (never its backstage note); an on-sale show A holds no ticket for
  shows the public's fields and empty doors; a filter on doors finds only A's; and once A's ticket
  no longer points to the show, A no longer reads it.
- With the "their own record points to it" condition removed from the source (`reachedWhere`
  returning `1 = 1`), the suite fails with **58 leaks** (B's held show's name and doors, the
  draft show, the on-sale show's doors) and the declared-fields case fails. With the field list
  ignored (every field of the object readable), the declared-fields case fails on A's own
  backstage note. With the per-column `CASE` removed, the suite finds **38 leaks** (an on-sale
  show's doors).
- `apps/runner/test/ticketing.test.ts`: after a holder's event is moved to a new date and ended,
  `myTickets` shows its name, the new date, venue, state `ended` and the ticket type's name; a
  customer with no ticket gets not-found for both, exactly as for an id that does not exist; the
  holder's order for another ticket of the ended event is refused as one for an id that does not
  exist (with `visibleSource` in place of `buyableSource` in `priceLines`, that test fails); the
  order page still names the line.
- `packages/core/test/public-scope.test.ts`: the declaration's checks and the runtime refusal.
- `packages/core/test/customer-via.test.ts`: `customerVia` beside `signedIn` on one object. Every
  member reads a class's shared fields; a pass holder also reads its room, another member sees the
  room empty and cannot find it by filtering; no member reads the coach's note; the public reads
  nothing.

## Consequences
- One subquery per read of an object a customer reaches this way. It reads the `from` view by its
  customer column, which should be indexed (Ticketing indexes the ticket's holder).
- `capacity.get` answers a holder for the ticket type and event they hold, as for any record
  their scope shows them (ADR 0433): they learn whether it sold out.
- A customer's write that sets a relation may point it at a record they reach this way (ADR
  0447's check reads their scope).
- An order's lines keep the title they were bought with (stage 25), so the order page (`order.get`,
  `order.view`) names what was bought whatever its state; it needed no change.
