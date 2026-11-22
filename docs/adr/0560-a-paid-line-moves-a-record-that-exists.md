# ADR 0560: A paid line moves a record that exists (`sellable.moves`), and drop-ins

Status: accepted, 2026-11-23 (stage 31a, build step 8; amended the same day after review, below).
Extends [ADR 0435](0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md) (`sellable`),
[ADR 0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md),
[ADR 0428](0428-buying-without-an-account.md) and
[ADR 0429](0429-payments-gatekeeper-verified-events-and-refunds.md) (orders, guests, payments,
refunds a person approves), [ADR 0501](0501-a-record-s-states-claim-its-place.md) (claimants),
[ADR 0506](0506-a-spender-paid-another-way.md) (`waived`), [ADR 0540](0540-the-family-link.md)
(the family link) and [ADR 0550](0550-timed-moves-and-a-cancel-that-races-a-booking.md) (the
guard a booking racing a cancel needs). Stage 31's spec, "Paying for a drop-in at booking"
(decisions 8, 13 and 15).

## Context
A visitor, or a member with nothing to spend, pays for one class on the gym's website (decision
8): the place is held while they pay, a verified payment books them, and an order left unpaid lets
the place go. A class the gym cancels gives a drop-in payer their money back to their card, as a
refund a person approves (decision 15); the spec guessed the same for a payer's own in-time cancel.
Members never learn who else is booked (decision 13), and a guest never reads a Person (ADR 0428).

Until now a paid line could only grant new records (ADR 0435). A drop-in is a booking that must
exist while the order is unpaid, holding a real place under the class's own rules (its windows,
the staff-only rule, places refused by the database, the waiting list's held places), and must
follow the order: booked when paid, released when it expires. No pack may hook a write (ADR 0404),
and a tool that made the booking and then the order would leave one without the other whenever
the second call failed.

## Decision

**The declaration.** `sellable.moves: { held, paid, expired, refund?, price?, title?, order?,
guest?, holdCap? }` (`packages/sdk/src/sellable.ts`, `MovesSpec`):
- `held` is a state only the host creates records in and only the host moves them out of (the SDK
  refuses any other creator or mover, so nobody holds a place without an order); `paid` and
  `expired` are host moves from it, `expired` final; `refund` lists the states that give the money
  back.
- `price` is a number path through up to two relations (`class.classType.dropInPrice`) and the
  extension's number setting used when it is empty (ADR 0505's reader), written by the host into
  the object's read-only `price` field; `title` is the line's title path; `order` a read-only text
  field for the order's id.
- `guest: true` lets a buyer who is not signed in buy it without being matched to a Person before
  payment (below). The customer field must then not be `required`; the host keeps it set in the
  paid state and every open state, for every writer (`assertGuestHeld`, records/lifecycle.ts).
  Without `guest`, the public cannot buy the object.
- `holdCap: { setting }` names a number setting: the percent of the claimed record's places that
  unpaid guest holds may take at once.

The object declares `customer` and `states`; a spender declares `waived`. Not with `grants`,
`deposit`, `recurring`, `onePerPerson`, `maxPerOrder` or `saleWindow`: one record on one order.
As every `sellable`, only a shipped pack or the org's own extension may declare it.

**`order.startHeld`** (core, `hostInternal`, audiences staff, customer and public, `write`,
`records:write`, not on MCP) makes the record and its order in one batch, as the host
(`orders/moves.ts`, `startHeld`). It is reached only through a pack's tool, for everyone: the
pipeline's `toolOnly` holds customers and the public to that, and the handler refuses a staff call
(a person, the assistant, MCP) that is not a tool run.
- **What the caller may set**: the object's `customer.write` fields, never its state, whose it
  is, who made it, its holder, its waived mark, its price or its order. A relation may point only at
  a record the buyer reads through their own scope (the public: a scheduled class), else not found.
- **A guest is matched to no Person before payment** (the coordinator's decision on review,
  following ADR 0428): the address is checked only as an address (one that is not one, or an
  erased person's, is refused in the same words); the record is held with its customer field
  empty and the order belongs to no one. So the answer is the same whatever the address matches,
  the hold is nobody's (not in anyone's `mine`), and it blocks nobody's own booking (the declared
  uniqueness counts no empty Person). A signed-in customer buys as themselves or, with
  `forPersonId`, for a live dependant on an object that lets guardians write (the link's guard rides
  in the batch, ADR 0540), and their own one booking per class is refused up front as before.
- **The record's own rules, judged as the caller's create would be** (`assertCreateRules`, the
  engine's own code): closed for everyone, with the guard that what the closed flag is read through
  has not moved before the batch commits (migration 0670's `unmoved`: a class cancelled between the
  read and the commit fails the buy, `core_moved_meanwhile`); the create window and staff-only rule
  unless staff. The host then creates it as the host into `held`, so the claimant hook holds its
  place (refused by the database past the places, the waiting list's held places included). A
  spender's `waived` is set: a drop-in spends no use.
- **Limits on unpaid guest holds**: a class carries at most `holdCap`'s percent of its places
  (Bookings: `dropInHoldPercent`, default 50, at least one, a person's to change) in unpaid
  drop-in holds at once, counted by the database in the buy's batch after its own claim (migration
  0690's `held_cap` guard on core_write_guard: of two at once only one passes the last); and one
  address starts at most 3 guest drop-ins in 15 minutes (read from its orders). Either refusal is
  the same "too many places are being held for payment just now: try again shortly"
  (`rate_limited`, `try_later`), whatever the cause.
- **The price** is read from the path, else the setting, in the deployment's currency; none, or
  nothing to pay, is `no_price`. The order's line is priced from it in the same batch
  (`createOrder` with the host's own priced line, which no operation takes from its input). A
  record of such an object is never put on `order.start` (`not_for_sale`), by its buyer or by
  staff: a second order for one held place would be paid twice. Tax at checkout applies as for any
  line (ADR 0479).

**The order's moves** (a move hook on the order, in the batch of the write that moves it):
- `pending` → `paid`: the record `held` → `paid` as the host (the claim confirmed). A guest's is
  given its Person first, by the rule a guest's order uses (ADR 0428): one live Person with the
  address is theirs, none makes one (in the batch), several leave it paid and still held until
  staff set the order's Person (`order.setPerson`, which then settles it the same way, and admins
  are told as for any such order). When that Person already has a live booking of the class (they
  booked it themselves meanwhile), the paid drop-in is not kept as a second place: it goes to
  `expired`, its place back, a refund is owed and admins are told.
- `pending` → `expired` or `cancelled`: `held` → `expired` (the place released, and handed to the
  waiting list before its cut-off, ADR 0520).
- `expired` → `paid` (a late payment staff would honour) is refused (`held_gone`): the place went
  back at expiry and may be someone else's.
- **A late payment** (an order that closed: expired, or cancelled because its class was cancelled
  while it was held) on such an order owes its refund (`entered: "late"`), in the payment's batch,
  and admins are told; it is never honoured.
- A payment applied to a record that left `held` another way owes a refund and tells admins.

**The record's moves** (a hook on every object's moves, which returns at once without the
declaration: `onEveryRecordMove`): leaving `held` another way (a class the gym cancels, by the
state cascade) cancels its unpaid order in the same batch (the order machine's `pending` →
`cancelled` gains `host`), or, when its order is already paid (a guest waiting for staff), owes the
refund. Entering a `refund` state from any other state while its order is paid writes **a refund
owed** (`core_sellable_refund_due`, migration 0690, one per order) in that batch. Nothing in a
record's or an order's batch calls the payments gatekeeper.

**A drop-in staff move to another class** (step 7's `move`) carries its order with it: the new
booking gets `dropInOrder` (host-set, as `madeBy` is) and the order's line points at it, so a later
in-time cancel or class cancel of the new booking owes the refund, once, and the old one owes
nothing (allowance/records.ts, where the move is made).

**Asking for what is owed** (`orders/refund-due.ts`). The minute cron (`runRefundsDue`, beside the
orders tick):
1. claims each owed row in its own statement (`due` → `asking`, its attempt counted);
2. calls `order.refundDue` (`automation` only, `orders:refund`, risk `outbound`, bookkeeping as
   `order.refund` is), which asks exactly as `order.refund` does: one refund per payment, newest
   first, each the gatekeeper's outbound action `payments.refund`, always reviewed and approved only
   by a person with `orders:refund`, never by an AI (ADR 0429). Each refund's id is
   `rfd_<row>_<attempt>_<n>`, which the gatekeeper passes to the provider as the idempotency key
   (Stripe's and the fake's): an action left from a crash and approved is still one refund. A refund
   the approval policy did not put in front of a person (denied) fails the ask. The row is `asked`,
   or `skipped` when nothing is left to refund (staff refunded it by hand, or one already waits);
3. a row the operation failed on (denied by the policy, payments not set up), or left `asking` for
   15 minutes (the Worker stopped), is never asked again by itself: it is `skipped` with why, and
   admins are told; when an approval for it is in fact waiting (the crash came after the action was
   made), they are told to approve that one and not refund again;
4. an `asked` row is `done` once the order is refunded, and `lapsed` once every approval asked for
   was rejected or expired: admins are told once, with why, to refund it from the order (where
   `order.refund` asks again, which a refund still waiting for a person refuses).

**`movingNow`** (the set that keeps the order's and the record's hooks from moving one record twice
in a batch) holds each id only for the call that moves it. Two writes racing on one record are kept
apart by the database, not by it: the transition history's unique current row fails the later
batch.

**Bookings** declares it on the booking: `held: "pending"`, `paid: "booked"`, `expired:
"expired"`, `refund: ["cancelled", "excused", "cancelled_by_us"]` (the states that give a use
back, the spec's "same rule as a use given back", less `moved`, whose payment follows the booking),
the price from the class type's `dropInPrice`, else the organisation's `dropInPrice` setting
(both `personApproves`), the class's title, the order in `dropInOrder`, `guest: true` (the
booking's `person` is no longer required; the host keeps it set outside a guest's unpaid hold),
`holdCap: { setting: "dropInHoldPercent" }`; tax code `txcd_50021003` (Stripe's "Fee for Personal
Training/Fitness Classes", overridable by a human admin). A late cancel and a no-show keep the money
(no fee, no refund). Its tool `buy { classId, forPersonId?, email? }` (customer and public,
`write`) calls `order.startHeld`; a web block (`bookings-drop-in`) and the timetable (for a member
refused for want of a use) open the provider's page. Native blocks are `noPurchase` and the block
lint refuses `x.bookings.buy` and `order.checkout` in them.

## Amended 2026-11-23 (second review, before merge)
- **A payment owed back on its own is exactly that payment.** A second payment on a paid order
  (a guest who opened the provider's page twice), and every payment after the order closed, owes
  back that payment's own amount, one owed row per payment (`payment_ref`, `amount`; the unique key
  is the order and the payment), refunded from that payment alone. A paid order's first payment is
  never touched by it. A cancel's refund is still the whole order's, one row per order.
- **Erasing a Person** deletes their records of an object whose Person is optional only because of
  `guest`, as when it was required (places back, the waiting list's hand-on as before). A row that
  points at the Person twice (its Person and who made it) gives its places back and is deleted once.
- **A paid guest hold nobody can have** does not sit for ever: an address erased, held only by a
  Person in the Trash, or with no admin to make a Person for, at payment, releases the place and
  owes the refund, admins told (the payment is applied, never failed); an address several People
  share that staff have not settled by the time booking for it closes (the class's start by default)
  is released and owed back the same way, by the minute cron's expiry.
- **The cap is on visitors' holds**: the trigger counts every unpaid hold, and the host adds the
  signed-in members' unpaid holds it reads to what it may count, so a member's own drop-in never
  turns a visitor away (a member's made at the same moment may, once).
- **The per-address limit is best effort**: read before the batch, so starts at the same moment
  may pass together; the per-class cap in the batch is the guard. It is keyed by the mailbox
  (`+tags`, and Gmail's dots, folded, as a sign-in code's limit is).
- **Paying with someone else's address** is accepted, as for `order.start`'s guests (ADR 0428):
  the paid drop-in becomes that Person's booking, or is refunded when they already have one.
- A refund approval that failed when applied is reported as failed; when the cron gives up with
  approvals already waiting, admins are told which actions wait and that the rest was not asked.

## Why
- One batch for the record and its order is the only way neither exists without the other. Making
  the record as the host, after judging the caller's input with the engine's own rule code and the
  same guard, keeps `held` closed to every other creator while the caller is held to every rule
  they would meet.
- A guest matched to no Person until payment is ADR 0428's rule ("a guest never reads a Person")
  made true for a held place: any answer that depended on the address would say who is booked.
- Reading the price at the buy, from the class type or the organisation, is ADR 0505's reasoning.
- A refund owed is written in the move's batch and asked for after it commits, because asking the
  gatekeeper writes a pending action outside the batch.
- Refusing to honour a late drop-in payment, and owing it back instead, is the safe side of a race:
  the place may be another buyer's, and a refund is always possible.

## Consequences
- A visitor cannot join a waiting list: joining is a member's, and promotion spends a use, which a
  drop-in payer does not hold. A full class (its held places included) is refused to a buyer.
- What the host does not limit: the number of addresses one client uses. The per-class cap bounds
  what they can hold, and the edge rate limit on the public API routes (the deployment's, stage 23)
  bounds the calls. The host never sees a client address.
- A signed-in member's own pending drop-in counts as their one booking of the class, as before.
- A staff `order.refund` of a booked drop-in moves nothing: staff cancel the booking (in time it
  owes nothing more, and the sweep skips it).
- Everything here is proved on the fake provider only; `docs/payments-stripe-runbook.md` lists the
  test-mode checks a person makes with Stripe.

## Proof
`apps/runner/test/bookings-drop-in.test.ts` (26, the shipped packs, the real gatekeeper and its
fake provider): a visitor's place held while unpaid, nobody's and no Person made, booked by the
verified payment with a Person made then and no use spent; the class type's price over the
organisation's, neither refused; the caller setting the price, state or waived mark refused,
`order.startHeld` unreachable but through a tool (staff too), a held booking refused on
`order.start` as its member and as staff; tax inside the price with the code on the line; an unpaid
order expiring and its place released, a payment after it late, owed back and not honoured; a
payment for a hold whose class was cancelled meanwhile owed back; a class cancelled between the
buy's read and its commit (a closure committed from inside the buy) refusing the buy, and the
other way round; a buyer cancelling the unpaid order; three visitors for the last place, one held;
a full class and a place held for the waiting list refused; a member's own pending drop-in
counting as their booking; a stranger using a member's address answered the same, holding nothing
in the member's name, and refunded (with staff told) when matched to the member's existing place;
an address several People share waiting for staff, then booked by `order.setPerson`; the per-class
cap and the per-address limit, both `try_later`; payment and expiry at the same moment; an expired
hold handed to the waiting list; not open yet and staff only; a parent paying for a linked child
and nobody else; an in-time cancel owed, asked for once, not approvable by the assistant, refunded
when a person approves; an approval rejected lapsing, staff told once and able to ask again; a
policy denying the host's refund leaving nothing asked and staff told; a paid drop-in moved by staff
owing its refund once on the new booking; a late cancel keeping the money; a closure and staff
cancelling a class (a late-cancelled drop-in included); a refund staff made by hand not asked
twice. Each fix of the review was broken in turn and its test failed (the guard, the cap, the
second-order rule, the lapse, the move's order). `packages/sdk/test/sellable-moves.test.ts`,
`packs/bookings/test`, `scripts/check-blocks.test.mjs`.
