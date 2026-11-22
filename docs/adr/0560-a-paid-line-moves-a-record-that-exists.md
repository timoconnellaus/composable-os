# ADR 0560: A paid line moves a record that exists (`sellable.moves`), and drop-ins

Status: accepted, 2026-11-23 (stage 31a, build step 8). Extends
[ADR 0435](0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md) (`sellable`),
[ADR 0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md) and
[ADR 0429](0429-payments-gatekeeper-verified-events-and-refunds.md) (orders, payments, refunds a
person approves), [ADR 0501](0501-a-record-s-states-claim-its-place.md) (claimants),
[ADR 0506](0506-a-spender-paid-another-way.md) (`waived`) and [ADR 0540](0540-the-family-link.md)
(the family link). Stage 31's spec, "Paying for a drop-in at booking" (decisions 8 and 15).

## Context
A visitor, or a member with nothing to spend, pays for one class on the gym's website (decision
8): the place is held while they pay, a verified payment books them, and an order left unpaid lets
the place go. A class the gym cancels gives a drop-in payer their money back to their card, as a
refund a person approves (decision 15); the spec guessed the same for a payer's own in-time cancel.

Until now a paid line could only grant new records (ADR 0435). A drop-in is a booking that must
exist while the order is unpaid, holding a real place under the class's own rules (its windows,
the staff-only rule, places refused by the database, one live booking per Person, the waiting
list's held places), and must follow the order: booked when paid, released when it expires. No
pack may hook a write (ADR 0404), and a tool that made the booking and then the order would leave
one without the other whenever the second call failed.

## Decision

**The declaration.** `sellable.moves: { held, paid, expired, refund?, price?, title?, order? }`
(`packages/sdk/src/sellable.ts`, `MovesSpec`). `held` is a state only the host creates records in
and only the host moves them out of (the SDK refuses any other mover, so nobody holds a place
without an order); `paid` and `expired` are host moves from it, `expired` final; `refund` lists the
states that give the money back; `price` is a number path through up to two relations
(`class.classType.dropInPrice`) and the extension's number setting used when it is empty (ADR
0505's reader), written by the host into the object's read-only `price` field; `title` is the
line's title path; `order` a read-only text field for the order's id. The object declares
`customer` and `states`; a spender declares `waived`. Not with `grants`, `deposit`, `recurring`,
`onePerPerson`, `maxPerOrder` or `saleWindow`: one record on one order. As every `sellable`, only a
shipped pack or the org's own extension may declare it.

**`order.startHeld`** (core, `hostInternal`, `toolOnly`, audiences staff, customer and public,
`write`, `records:write`, not on MCP) makes the record and its order in one batch, as the host
(`orders/moves.ts`, `startHeld`):
- **What the caller may set**: the object's `customer.write` fields, never its state, whose it
  is, who made it, its holder, its waived mark, its price or its order. A relation may point only at
  a record the buyer reads through their own scope (the public: a scheduled class), else not found.
- **Who pays and whose it is**: a signed-in customer pays, for themselves or, with `forPersonId`, a
  live dependant on an object that lets guardians write (the link's guard rides in the batch, ADR
  0540); a guest gives an address (ADR 0428's buyer, a Person made in the batch when new) and names
  no one else; an address several People share is refused (an order may wait for staff to say
  whose, a held place may not). `madeBy` is the payer.
- **The record's own rules, judged as the caller's create would be** (`assertCreateRules`, the
  engine's own code): closed for everyone; the create window and staff-only rule unless staff. The
  host then creates it as the host into `held`, so the claimant hook holds its place (refused by
  the database past the places, the waiting list's held places included) and the declared
  uniqueness index refuses a second live record. A spender's `waived` is set: a drop-in spends no
  use.
- **The price** is read from the path, else the setting, in the deployment's currency; none, or
  nothing to pay, is `no_price`. The order's line is priced from it in the same batch
  (`createOrder` with the host's own priced line, which no operation takes from its input). A
  record of such an object is never put on `order.start` (`not_for_sale`): a second order for one
  held place would be paid twice. Tax at checkout applies as for any line (ADR 0479).

**The order's moves** (a move hook on the order, in the batch of the write that moves it):
`pending` → `paid`: the record `held` → `paid` as the host (the claim confirmed); `pending` →
`expired` or `cancelled`: `held` → `expired` (the place released, and handed to the waiting list
before its cut-off, ADR 0520). `expired` → `paid` (a late payment staff honour) is refused
(`held_gone`): the place went back at expiry and may be someone else's, so staff refund instead.
A payment applied to a record that already left `held` owes a refund and tells admins.

**The record's moves** (a hook on every object's moves, which returns at once without the
declaration: `onEveryRecordMove`): leaving `held` any other way (a class the gym cancels, by the
state cascade) cancels its unpaid order in the same batch (the order machine's `pending` →
`cancelled` gains `host`), so the provider's page cannot take money for it; a payment made anyway
is a late one, which staff refund. Entering a `refund` state from any other state while its order
is paid writes **a refund owed** (`core_sellable_refund_due`, migration 0690, one per order) in
that batch. Nothing in a record's or an order's batch calls the payments gatekeeper.

**Asking for what is owed.** The minute cron (`runRefundsDue`, beside the orders tick) claims each
owed row in its own statement (`due` → `asking`), then calls `order.refundDue` (`automation` only,
`orders:refund`, risk `outbound`, bookkeeping as `order.refund` is), which asks exactly as
`order.refund` does: one refund per payment, newest first, each the gatekeeper's outbound action
`payments.refund`, always reviewed and approved only by a person with `orders:refund`, never by an
AI (ADR 0429). It becomes `asked`, or `skipped` when nothing is left to refund (staff refunded by
hand). A row the operation fails on, or one left `asking` for 15 minutes, is never asked again by
itself: it is `skipped` with why and admins are told to refund by hand. Asking twice could put two
refunds in front of a person; telling them cannot.

**Bookings** declares it on the booking: `held: "pending"`, `paid: "booked"`, `expired:
"expired"`, `refund: ["cancelled", "excused", "cancelled_by_us"]` (the states that give a use
back, the spec's "same rule as a use given back", less `moved`, whose payment follows the booking),
the price from the class type's `dropInPrice`, else the organisation's `dropInPrice` setting
(both `personApproves`), the class's title, the order in `dropInOrder`; tax code `txcd_50021003`
(Stripe's "Fee for Personal Training/Fitness Classes", overridable by a human admin). A late cancel
and a no-show keep the money (no fee, no refund). Its tool `buy { classId, forPersonId?, email? }`
(customer and public, `write`) calls `order.startHeld`; a web block (`bookings-drop-in`) and the
timetable (for a member refused for want of a use) open the provider's page. Native blocks are
`noPurchase` and the block lint refuses `x.bookings.buy` and `order.checkout` in them.

## Why
- One batch for the record and its order is the only way neither exists without the other. Making
  the record as the host, after judging the caller's input with the engine's own rule code, keeps
  `held` closed to every other creator while the caller is held to every rule they would meet.
- Reading the price at the buy, from the class type or the organisation, is ADR 0505's reasoning:
  a copy on each class goes stale. The line keeps what was charged.
- A refund owed is written in the move's batch and asked for after it commits, because asking the
  gatekeeper writes a pending action outside the batch: a cancel that failed would otherwise leave
  a refund for a person to approve for a booking that still stands.
- Refusing to honour a late drop-in payment is the safe side of a race: the place may be another
  buyer's, and a refund is always possible.

## Consequences
- A visitor cannot join a waiting list: joining is a member's, and promotion spends a use, which a
  drop-in payer does not hold. A full class (its held places included) is refused to a buyer.
- Anyone can start a drop-in with someone else's address (ADR 0428's consequence): it holds one
  place for up to the order's expiry (15 minutes by default) and, while it is held, the one live
  booking per Person refuses that Person's own booking of the same class. The edge rate limit on
  the public API routes is what bounds it.
- A staff `order.refund` of a booked drop-in moves nothing: staff cancel the booking (in time it
  owes nothing more, as the money was already asked for, and the sweep skips it).
- Everything here is proved on the fake provider only; `docs/payments-stripe-runbook.md` lists the
  test-mode checks a person makes with Stripe.

## Proof
`apps/runner/test/bookings-drop-in.test.ts` (16, the shipped packs, the real gatekeeper and its
fake provider): a visitor's place held while unpaid and booked by the verified payment with no use
spent; the class type's price over the organisation's, neither refused; the caller setting the
price, state or waived mark refused, `order.startHeld` unreachable but through a tool, a booking
refused on `order.start`; tax inside the price with the code on the line; an unpaid order expiring
and its place released, a payment after it late and not honoured; a buyer cancelling the unpaid
order; three visitors for the last place, one held; a full class and a place held for the waiting
list refused; one live booking per Person with a pending drop-in, as a member and by the same
address as a guest; not open yet and staff only; a parent paying for a linked child and nobody
else; an in-time cancel owed, asked for once, not approvable by the assistant, refunded when a
person approves; a late cancel keeping the money; a closure cancelling a paid drop-in (owed and
asked for) and a pending one (its order cancelled); a refund staff made by hand not asked twice.
`packages/sdk/test/sellable-moves.test.ts` (the declaration's checks), `packs/bookings/test`
(the declaration and the `buy` tool's calls and refusals), `scripts/check-blocks.test.mjs` (native
blocks cannot buy).
