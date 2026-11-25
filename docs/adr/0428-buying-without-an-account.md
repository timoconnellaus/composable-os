# ADR 0428: Buying without an account, and the host's own writes for a caller outside the org

Status: accepted, 2026-11-21 (stage 25 build, second half). Builds on ADRs
[0402](0402-staff-and-customers.md), [0412](0412-customer-scope-and-principals-as-built.md),
[0413](0413-outside-handlers-have-no-raw-database.md) and
[0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md).

## Context
The stage 25 interview decided that buying needs no account: a Person is matched or created from
the email given, and the account can be claimed later. That opens two operations to the public,
which until now could call nothing, and it means the host creates records (an order, sometimes a
Person) during a call by someone who may change no record at all. Stage 22's rule is that a
customer's or the public's handler has no database and that the seam has the last word on every
change the call records.

## Decision

**Four operations are open outside the org,** each listed in `open-operations.json`:

| Operation | Open to | What it does |
| --- | --- | --- |
| `order.start` | staff, customers, the public | Starts an order priced by the host |
| `order.view` | anyone holding the order's token | Shows that one order |
| `order.get` | staff, customers | An order through the seam: a customer's own only |
| `order.cancel` | staff, customers | A customer cancels their own order with nothing paid on it |

`order.start`, `order.view` and `order.cancel` are `hostInternal` (ADR 0413): the host itself
starts and changes the order, so they keep the database. `order.get` is not: it reads through
`ctx.records` like any other customer read.

**Whose order a guest's is** (`resolveBuyer`): the address is matched by the same-email rule
stage 22 uses at sign-in (ADR 0247).
- One live Person has it: the order is theirs.
- No one has it: a Person is created with it, in the order's own batch, by the code
  `person.create` runs, for the admin who invited the address or the first active admin (as at a
  customer's first sign-in). The order and the Person exist together or not at all.
- Several have it: the order keeps the address and belongs to no one; admins are notified to
  merge them and then set the order's person (`order.setPerson`). It can still be paid.
- An address that is not one, and an erased person's address (the erased-address list), are
  refused with the same words.

A guest never reads a Person: no answer to a guest carries a person id or echoes the address.
When someone later signs in with the address, verified by a code, the orders are already theirs,
because they belong to the same Person.

**A guest's way back is a token, stored as a hash.** `order.start` gives a guest 256 random bits,
once; only its SHA-256 is kept on the order, and it is not in the audit log. `order.view { id,
token }` shows that order while it is open (pending or part paid, however long that is) and for
30 days after it closes. A wrong id, a wrong token and an old link are one answer. The stage's
spec says "a signed token"; a stored hash was chosen because a handler has no signing secret (auth
secrets are env-only and never reach core), and it needs none: the token cannot be forged, opens
one order, and stops working when the order is erased.

**The host's own change is recorded as the host's.** The seam checks every change a customer's
or the public's call records (ADR 0412), and the public may change nothing. A `hostInternal`
core operation now has `recordHostChange` beside `recordChange`. What it records with
`recordHostChange` is a change the host made in reviewed core code after judging the caller's
input (an order it priced, the Person a guest's order is placed for): the seam lets it through.
What it records with `recordChange` is checked in full, exactly as before. No extension tool is
`hostInternal`, and a tool starter gets neither, so nothing a pack writes takes this path.

## Why
- The alternative to `recordHostChange` was to leave the order out of the audit log on a guest's
  call, or to let every change of a `hostInternal` operation through. The first loses the diff;
  the second removes a lock stage 22 built on purpose. An explicit, separately named call keeps
  the lock for everything that does not ask, and every use is in core and greppable.
- Creating the Person in the order's batch means there is never a Person with no order from a
  checkout that failed half way.
- Matching by the sign-in rule means one definition of "the same person" in the host.

## Consequences
- The public can cause writes for the first time: an order and sometimes a Person per call.
  Nothing limits the public per client address in the host; a deployment that sells needs the
  edge rate-limiting rule stage 23 documents on its API routes. A customer's calls are limited
  per account as before.
- Anyone can place an order with someone else's address. That Person then sees a pending order
  they did not start, which expires. Nothing of theirs is shown to the guest.
- The confirmation email carries the token; sending it is the rest of stage 25.
- `order.view` answers staff and customers too: holding the token is the proof, whoever holds it.

## Amended 2026-11-23: a guest's acceptances settle with the order (stage 44 step 3, [ADR 0644](0644-enforcement-nobody-pays-or-books-without-what-is-due.md))
- **A guest agrees in the buying call.** `order.start` (and `order.startHeld`, through a pack's
  tool) takes `agreements`: the guest's acceptances of every document attached for everyone at the
  points of what they buy, checked without reading any Person (the answer is the same whatever the
  address matches; a member who has agreed is asked again). They are recorded with the order and
  the order's address, with no Person.
- **They become the order's Person's** once something is paid on the order and it has a Person: the
  verified payment's batch, or `order.setPerson`'s when the address matched several People
  (migration 0853's trigger). An order that closes unpaid (expired, cancelled) deletes them.
- **Staff starting an order for an address several People share** are refused while anything is
  due there: nobody's acceptances can be read until staff merge them.

## Amendment, 2026-11-24 (stage 29, ADR 0721)
Whose a typed address is is now one shared matcher, `personForAddress`
(`packages/core/src/customers/address-person.ts`): `resolveBuyer` calls it, and so does the
submitter of a form (`intake.submit`). Same rules and same words. See
[ADR 0721](0721-the-submitters-person-and-certainty.md).

## Amendment, 2026-11-25 (stage 37 step 3, ADR 0682): a guest's delivery address
A guest buying goods to be posted gives the address with the order (`order.start`'s
`delivery.address`). It is kept by the host in `core_order_delivery`, in no view and never in the
audit log, and the guest reads it back only with the order's token (`order.delivery.get`). A
collect or take-it-now order needs none. Erasing the Person the address becomes theirs with blanks
it. See [ADR 0682](0682-goods-on-an-order-where-sold-the-channel-and-the-delivery.md).
