# ADR 0447: The signed-in scope, and what a customer's write may point at

Status: accepted, 2026-11-21 (stage 41, build step 1). Builds on ADRs
[0402](0402-staff-and-customers.md), [0412](0412-customer-scope-and-principals-as-built.md),
[0414](0414-pack-tools-run-as-the-customer.md), [0437](0437-a-move-is-made-from-a-current-read.md)
and [0438](0438-the-public-scope.md). Amends ADR 0438 on `my.*`.

## Context
A class program is assigned to a class type, and its sessions are read by every member who
signs in: the class they turn up to, with its levels. They are not any one member's records, so
the customer scope (a record whose customer field is the caller's Person) does not reach them. The
public scope (ADR 0438) would, but it opens them to anyone without an account, and a gym's
programming is not for the public. The exercise bank is the same: members read the exercises a
program of theirs uses; the public does not.

Logging showed a second gap. A pack's tool writes for a customer with `my.create` and `my.update`,
and the seam checked whose the written record is, but a relation the record pointed at was
checked by the record code against the host's own org-wide reader. A customer could log a set
against another customer's session, given its id.

## Decision

**An object declares `signedIn: { read, when? }`** (`SignedInSpec` in the SDK; the field registry
holds it as `signedIn`, with the shape and checks of `public`): the fields every signed-in
customer may read, of the records that meet `when` (a select of the record, or of the one a `via`
relation points to), or of every live record without it. Never the public. Only a shipped pack or
an org's own extension may declare it (`outside_audience` for a runtime extension, as for
`customer`, `public` and `sellable`); `cos ext check` prints it among the lines a reviewer reads.
An object declares `public` or `signedIn`, not both: what the public reads, a customer reads too.

**Beside a `customer` declaration, it shares records.** A customer's scope on such an object is
their own records or the shared ones: the source is
`SELECT … FROM rec_x WHERE <customer field> = :me OR <when>`. `signedIn.read` must be a subset of
`customer.read`; a column only the customer reads of their own is `CASE WHEN <customer field> =
:me THEN col END` in the source, so a shared record shows it empty and a filter on it finds only
the caller's own. Programs: an assignment and a session are a person's own (`customer: person`)
or a class type's (`signedIn` while `kind` is `class`).

**Alone, it opens records to read.** On an object with no customer, a customer's scope is the
signed-in declaration, read-only, exactly as the public scope is (it is the same scope with a
different declaration). Programs: the exercise bank and the class types.

**A customer reads them with `my.list` and `my.get`**, which now answer for objects that declare a
customer or `signedIn` (ADR 0438 kept `my.*` to a customer's own records; records shared with every
signed-in customer are declared for them on purpose, as their own are). `public.*` stays for what
the public may read.

**A customer changes only their own.** Every write check reads the caller's own records, not what
they may read: `ownedSource` (`visibility/index.ts`), used by `assertVisibleWrites` and
`updateVisible`. A shared record is not found for an update, exactly as another customer's.

**A customer's write may point a relation only at a record they can see.** `createVisible` and
`updateVisible` read every relation value the caller (or the tool calling for them) sets through
the caller's own scope, one read per relation field, and refuse an id they cannot see as not found,
the answer an id that does not exist gets. So a member logs a set against their own session or a
class's, never another member's. This holds for any pack, not only Programs.

**`my.update` takes `from`** (ADR 0437): a tool moving a customer's own record (a session marked
done) makes the move from a current read, through the same record code, and two marks at once
count once.

## Proof
- `packages/core/test/signed-in-scope.test.ts`: a customer reads their own and the shared, never
  another's; a shared row shows only `signedIn.read`, and a filter on a field it does not show
  finds only the caller's own; the signed-in-only object is read-only and the public read none of
  it; a shared record is not the caller's to change; a log pointed at another customer's session
  answers exactly as one pointed at an id that does not exist, and an update cannot move a log
  onto one. With `assertRelationsVisible` removed, the relation case fails.
- The stage 22 isolation suite (`packages/core/test/isolation-suite.ts`) gains assignments,
  sessions and logged sets in the fixture shop: each customer's own, and a class's shared by both,
  with a coach's note in its plan. Every open operation is called as A and as the public with B's
  ids, B's filters and relations pointed at B's records: no response holds a value of B's, of a
  shared record's staff fields or of a coach's note. With the log's customer filter removed from
  the seam, the suite finds 59 leaks.

## Why
- "Every signed-in member" is an audience of its own: narrower than the public, wider than one's
  own. Declaring it on the object keeps rows and fields the seam's decision, as for the other two,
  instead of a tool deciding who may see a class.
- Checking a relation through the caller's own scope is the only check that does not depend on the
  tool: the seam already decides which records a customer may name, so it decides which they may
  point at too.

## Consequences
- One more `OR` (and, through `via`, a subquery) on a customer's read of a sharing object. Both
  sides should lead an index so SQLite can use one for each: Programs indexes `person, …` and
  `kind, …` on assignments and sessions.
- A customer's write that sets a relation costs one read per relation field.
- Stage 14a's staff scopes extend this seam; the signed-in scope is a customer scope and does not
  change what staff see.

## Amended 2026-11-21 (ADR 0439)
`customerVia` sits beside this scope: on an object that declares both, a customer reads the
records their own records point to and the shared ones, each declaration's fields on the records
it covers (`CASE WHEN`, as here). `ownedSource` and the write checks are unchanged: a record a
customer reads through their own records is not theirs to change.
