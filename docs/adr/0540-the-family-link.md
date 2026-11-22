# ADR 0540: The family link: a guardian acts for a dependant, decided at the seam alone

Status: accepted, 2026-11-23 (stage 31a, build step 6). Extends
[ADR 0402](0402-staff-and-customers.md) (a customer reads and writes only their own records),
[ADR 0410](0410-the-seams-first-door-as-built.md) and [ADR 0412](0412-customer-scope-and-principals-as-built.md)
(the seam's customer scope), [ADR 0414](0414-pack-tools-run-as-the-customer.md) (a pack's tool
writes as the customer) and [ADR 0439](0439-what-a-customer-reads-through-their-own-records.md)
(`customerVia`). Stage 31's spec, "Parents booking for their children" (decision 14).

## Context
A gym runs kids' classes, and a parent books them for their child. Until now no customer could
act for another Person: a customer's scope was exactly the records whose customer field is their
own Person (ADR 0402, "left for later: a customer acting for someone else"). A child is a Person
who may have no email and no account; their membership or pass is their own (stage 32's question
13: the parent pays, the child holds).

Who may act for whom is identity. It widens what a customer reads and does, so it must not be a
pack's record (a pack or an import could make one), must not be decided by a tool (a tool deciding
"is this my child?" would be the pack hooking a write, ADR 0404), and must hold for every read and
write a customer makes, the same way, with no second place that could disagree.

## Decision

**A core record.** `core_person_link` (migration 0650): a guardian Person, a dependant Person,
kind `guardian` (the only kind), a note, who made it and when, and when it ended, by whom and why.
A dependant may have several guardians and a guardian several dependants; one live link per pair
(a partial unique index); never a Person to themselves (a CHECK). An ended link is kept as the
history of who could act for whom; it gives nothing.

**Made and ended by a person on the staff only.** `person.link.add` and `person.link.end`:
staff audience only, `actors: ["human"]`, permission `people:link` (admins by default, grantable
one by one as `orders:refund` is, [ADR 0449](0449-permissions-granted-one-by-one.md)). The assistant, an MCP client, an automation, extension
code and an import are refused by the actor rule whatever is granted; a customer and the public do
not see the operations at all. `person.link.add` refuses a pair already linked either way round.
Both post a timeline activity on the two People that names no one. `person.link.list` is a staff
read (`records:read`). There is no import of links: stage 33 proposes them for staff to apply.

**One place decides: the seam.** `packages/core/src/visibility/guardians.ts` holds the only code
that turns a link into access. A link is live while it has not ended and both People are out of
the Trash; it is read in the statement that needs it, never cached. One hop, one direction: a
dependant's own dependants are not their guardian's, and a dependant never acts for a guardian.

- **An object opts in**: `customer.guardians: { write?, madeBy? }` (SDK `CustomerSpec`, validated
  by the contract and by `customerProblems`). Left out, a guardian reads nothing of a dependant's
  on that object, so nothing that existed before this ADR widens. A runtime extension cannot
  declare it (it is part of `customer`, which only shipped and reviewed extensions declare).
- **Reads.** On such an object a customer's scope is their own Person's records *or a live
  dependant's* (`ownersWhere`), with the same `read` fields: every list, get, count and capacity
  read through `visibleSource` gets it at once. `customerVia` follows (a child's booking's class),
  when the `from` object opts in. Access sources (`holdsAccess`, ADR 0477) do not: holding a course
  stays the holder's own.
- **Writes.** With `write: true`, `ownedSource` (what a customer may change) includes a live
  dependant's records, so `my.update`, `state.resolve` and every other write path through it
  covers them, with the same `write` fields. A new record is the caller's unless `my.create` names
  `forPersonId`; the seam then requires a live dependant on an object that lets guardians write,
  and otherwise answers exactly as for a Person that does not exist (`not_found` for `person`), the
  same for another member, their child, an ended link, a Trashed child, a made-up id and an object
  that does not open. The owner field is still never the caller's to send in `values`.
- **In the write's own batch.** A write for a dependant (a create for them, or a change to their
  record) carries a guard statement (`core_person_link_guard`, whose trigger stores nothing and
  aborts the batch with `core_person_link_not_live` unless the link is live then). A link ended
  between the seam's check and the commit cannot be written through; the caller is told `not_found`.
- **Who made it.** `guardians.madeBy` names a relation to one person that the host sets on every
  record a customer makes, to the caller (the parent, on a child's). It is reserved: no customer
  and no tool (`customerFields`) may set it.
- **The family.** `me.family` (customer, read) answers the caller's own live links: themselves,
  their dependants and their guardians, by id and display name only. A link is shown to staff,
  its guardian and its dependant, never to anyone else.

**Merge and erase.** `person.merge` re-points the merged Person's links to the survivor in its
batch: a link between the two is deleted (it would link a Person to themselves), a live link the
survivor already has with the same Person the same way round is ended as a duplicate, and the rest
move, ended ones included. The merge preview counts the family links that move. `person.erase`
deletes every link of the erased People, live and ended (the foreign keys would too), and a
dependant left with no live guardian is not erased: the erase answers with them
(`dependantsWithoutGuardian`) and a note on their timeline says they have no guardian linked, naming
no one. A purge from the Trash deletes the links the same way; while in the Trash a Person's links
give nothing.

**A child who later signs in** is a customer like any other: their own records, and their own
family. The link stays; the guardian keeps acting for them until staff end it.

## Why
A link is identity, so it is core, made by a person, and read where every other customer rule is
read. Putting the decision in one module of the seam means a list, a get, a count, a capacity read,
a move, a dry run of a cancel and a create all ask the same question, and the isolation suite
(stage 22) proves it for every operation open to customers by aiming at another member's child.
Opting in per object keeps the default closed: Programs' logs, tickets and orders stay the child's.
The guard in the batch closes the race the read-then-write check would leave.

## Consequences
- The Bookings pack's booking opens to guardians (read and write, `madeBy`); the Memberships pack's
  memberships and passes open read only, so a parent reads what the child has left. Each lists
  `person` in `customer.read`, so a member's own records now show their own Person id.
- A parent's own membership is never spent on a child's class: the allowance spends the booking's
  Person's holders only (ADR 0493, built), and a parent naming their own pass for the child is
  refused as a pass that cannot pay.
- Emails about a dependant's booking (to whoever made it and the guardians) are step 9's; `madeBy`
  is what they read.
- Left out: a guardian adding a child themselves, age rules, links of other kinds, a chain of
  guardians, and a guardian's access to records an object reads through `access`.
