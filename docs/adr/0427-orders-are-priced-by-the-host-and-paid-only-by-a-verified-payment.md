# ADR 0427: Orders are priced by the host and paid only by a verified payment

Status: accepted, 2026-11-21 (stage 25 build, second half). Builds on ADRs
[0404](0404-behaviours-are-the-vocabulary.md), [0425](0425-one-transition-engine-for-stages-and-states.md)
and [0426](0426-who-moves-a-record-and-what-follows-a-move.md).

## Context
The stage 25 interview decided that an Order is a base record in core, priced by the host, in one
currency per deployment, and that only the provider's verified confirmation marks it paid. The
stage 27 interview added paying by deposit: a deposit now, the balance by a date, the rest paid
from a link in one go or in parts, no card stored. This ADR is how those are built in the host.
The payments gatekeeper, the checkout and the webhook route are the other half of the stage.

## Decision

**Order and Order line are base records with their own operations.** They are in the field
registry (`fields/order.ts`), so the visibility seam, the audit log and the transition engine
know them, and both declare a `customer`: a signed-in customer reads their own orders and those
orders' lines, and nothing is writable by a customer. They are not among the four core objects
the generic machinery walks (`listObjects`): search, embeddings, summaries, extension fields and
saved views do not pick them up, `record.create`, `record.update` and `record.delete` refuse
them, and `record.get` answers with none of their fields. Staff read orders with `order.get` and
`order.list`; a customer reads their own with `order.get`, or `my.get` and `my.list`.

**Money is an integer in the currency's minor unit.** `core_order.total`, `paid`, `deposit` and
every line amount are whole cents. A record's price is a number in the major unit; the host
converts it once, when the order starts, and refuses a price with more decimal places than the
currency has.

**One currency per deployment,** in `core_settings` (`order_currency`), changed only by a human
admin (`order.settings.update`, `actors: ["human"]`). Until it is set nothing can be sold. Every
order stores the currency it was started in. A line whose price field is declared in another
currency is refused.

**The host prices the order.** `order.start` takes records and quantities, and whether to pay in
full or by deposit. Its input has no price, total or amount, and unknown keys are dropped, so a
price sent anyway changes nothing. `createOrder` reads each record through the seam as the host,
takes the price from the field the object's `Sellable` names, and snapshots the title, unit price
and line total on the line. A later price change does not change an order.

**What may be bought is the host's list** (`orders/sellable.ts`): `registerSellable({ object,
price, deposit? })`, called by platform code. It is the seam stage 27's `sellable` declaration
fills from a manifest; it is not in the SDK or the contract. A record that is not for sale, does
not exist or is in the Trash gets one answer.

**The state machine is fixed in core** and held by the transition engine: `pending` → `paid` →
`refunded`; `pending` → `cancelled`; `pending` → `expired`; `expired` → `paid`; and for a deposit
`pending` → `part_paid` → `paid` and `part_paid` → `cancelled`. `paid`, `part_paid`, `expired` and
`refunded` are `host` moves. A customer may cancel their own order while nothing is paid on it;
staff may also cancel a part-paid one.

**Only a verified payment makes an order paid.** `applyVerifiedPayment(ctx, payment)`
(`orders/payments.ts`) is a function, not an operation. No operation passes its input to it, and
the moves it makes are `host` moves the engine refuses to every caller, so nothing a person, an
MCP client, an extension or an import sends can mark an order paid. It is called by the handler
that receives the gatekeeper's verified webhook, and it:
- changes nothing for an event applied before (the payment row's primary key is the provider and
  its event id, so two deliveries at once cannot both commit);
- checks the currency and that the amount is one the order could be charged (`chargeFor`); a
  mismatch moves nothing, is recorded, and admins are notified;
- records a payment for an order that has already closed as `late`, notifies admins, and never
  makes the order paid by itself;
- otherwise adds the amount to what is paid and moves the order, as the host, to `paid` when
  nothing is owed and `part_paid` when a balance remains, with the payment row, the history and
  whatever the move hooks add in the one batch.

**An order is written from a current read or not at all.** `core_order.version` counts updates,
and a trigger refuses an update of an order's money or state that does not say `version + 1`.
Two payments judged against the same read cannot both commit: the second fails its batch with a
conflict and is applied again.

**Paying by deposit.**
- A sellable may name a deposit field and a balance-due date field. A record offers a deposit
  when both have a value. `order.start { pay: "deposit" }` is refused unless every line offers
  one, the deposit is less than the total, and the balance is not already due. The order's
  deposit is the sum over its lines and its due date the earliest of theirs. A caller sends
  neither.
- `chargeFor(order, minPart, amount?)` says what a checkout may charge: with nothing paid, the
  total or the deposit and no other amount; part paid, the balance or a part of it of at least
  the set minimum (`order_min_part_payment`, default 10.00) and never more than the balance. A
  verified payment is held to the same rule.
- A part-paid order does not expire. Past its due date nothing moves: `order.overdue` lists it
  until staff extend the date (`order.extendBalanceDue`), cancel it, or it is paid.

**Events.** An order's changes are record changes, so `order.paid` and `order.partPaid` are the
order's `updated` record event whose diff moves `state` to `paid` or `part_paid`, with what is
now paid. An automation that needs the lines reads them. Code that must act in the paid batch
uses the move hook (ADR 0426).

## Why
- A function behind a `host` move is a rule that does not depend on a permission: no policy
  preset, role or scope can open a way to mark an order paid.
- Integers in minor units are the only representation a payment provider and the host agree on
  without rounding.
- The version check is one column and one trigger, and it turns a lost update into a retry.
- Keeping orders out of the generic object walk avoids embedding, summarising and exporting them
  by accident while they are being built, and can be reversed by adding them to the list.

## Consequences
- The gatekeeper's webhook handler is the only caller of `applyVerifiedPayment`. It must pass the
  provider's own event id, and apply an event again when it gets a conflict.
- `order.checkout` asks `chargeFor` before opening the provider's page, so the page and the
  later webhook agree on the amount.
- Nothing takes places for an order yet. `createOrder` and `orders/holds.ts` carry the marked
  places where stage 26's claims, confirms and releases go.
- The expiry sweep, late payments honoured by staff, refunds, the confirmation email and the
  admin screens are the rest of stage 25.
- An order has no timeline post of its own yet; its history is `core_transition_history`.

## Amendment, 2026-11-21 (the gatekeeper half, ADR 0429)
- `applyVerifiedPayment` is called by `order.applyPaymentEvent`, an operation open to the
  `automation` actor only whose input is the key of an event the host's adapter stored after the
  gatekeeper verified it. Its input cannot describe a payment, so the rule above stands.
- The machine gains `expired → part_paid` (`host`): a late deposit staff honour.
- An order carries `refunded` (what has gone back); refunds are in `core_order_refund`.
- Order moves post on the Person's timeline; "no timeline post of its own yet" no longer holds.
- Holds are wired (stage 26): see ADR 0429.

## Amendment, 2026-11-21 (stage 27, ADR 0435)
- What may be bought is no longer the host's list: `registerSellable` is gone. An object is for
  sale when its manifest declares `sellable` (ADR 0435), which also gives a sale window, a most per
  order and what a paid line grants. The rest of "The host prices the order" stands.

## Amendment, 2026-11-21 (stage 27, step 4): an extension's automation may be started by an order
`order.paid` and `order.partPaid` are the order's `updated` events; an extension's automation can
now name them: `trigger: { type: "fieldChanged", object: "order", field: "state", from, to }`
passes the check (`BASE_AUTOMATION_FIELDS` in `packages/sdk/src/automation-check.ts`), provided
the extension lists `order.get` in `permissions.operations`, since the run reads the order. Only
the trigger: no other part of a manifest may name `order`. Ticketing's "tickets by email" is the
first (from `pending` or `expired` to `paid` or `part_paid`: the first payment, once).

## Amendment, 2026-11-24 (stage 34 step 1, ADR 0690): the total is after adjustments
An order's `total` is now what is owed after its adjustments (money off, `core_order_adjustment`),
and each line keeps its price beside its share of them. The host still prices every order from the
records; the only amount a caller names is a staff discount's (`order.adjust`, ADR 0691), given by
a person with `orders:discount` within a limit a human admin set, or approved by one. The
amount-match rule is unchanged: it compares against the total, which is the net.
