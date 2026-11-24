# ADR 0694: An order paid another way

Status: accepted, 2026-11-24 (stage 34, build step 3; [the spec](../stages/34-offers.md), "An
order paid another way"). Amends [ADR 0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md)
(paid only by a verified payment), [ADR 0429](0429-payments-gatekeeper-verified-events-and-refunds.md)
(refunds only through the provider) and [ADR 0479](0479-tax-at-checkout.md) (tax at checkout).
Follows [ADR 0449](0449-permissions-granted-one-by-one.md) and
[ADR 0832](0832-the-notes-permissions.md) (restricted core permissions). Shared with stage 35
(invoices: a recorded transfer, cheque or card machine) and the till (stage 50: cash): they build
their own operations on it and do not redesign it.

## Context
Until now there was one door into `paid`: `applyVerifiedPayment`, a function only the gatekeeper's
verified webhook reaches (ADR 0427). A business is also paid by bank transfer, in cash, by cheque
and on a card machine the provider does not see, and later by value the host holds (a gift
voucher, a gift card, account credit). Three stages need this; written three times it would be
three doors to review. One function, one payment row shape, one guard.

## Decision

**A second door, `applyOtherPayment`** (`orders/payments.ts`), beside `applyVerifiedPayment`: a
function, not an operation, that writes a `core_order_payment` row and moves the order as the host
in the same batch, through the **same settle path** the verified payment uses (`settle`: paid or
part paid, then the move hooks: grants, holds confirmed, `sellable.moves`, one-per-Person uses
spent, a guest's acceptances settled). Only named operations call it, each with its own checked
inputs and a person behind it; none passes its input through. It refuses an order that owes
nothing (not pending or part paid), an erased one, a pending one with a person's discount waiting
for approval (ADR 0691: its price is not settled), and any amount over what is owed. The currency
is always the order's. A part payment leaves the order part paid, its balance due now when it had
no due date (so it shows among the overdue).

**The payment row has a `method`** (migration 0952): `provider` (every row before, and the till's
card reader, ADR 0774), `recorded` (a person says they received it: `recorded_kind` `transfer`,
`cash`, `cheque`, `card_machine` or `other`, `recorded_by`, `received_on`, `reference`),
`voucher` and `stored_value` (stage 34 steps 7 and 8). The host's rows are named provider `host`
with an event id the host makes (`opy_…`), so the primary key still means "applied once", and
`payment_ref` is that id (what a refund or a reversal names). `rec_order_payment` reports them by
method.

**The database's guard.** Triggers refuse: a provider row named `host` and a host row named
anything else; a host row that is not `applied`; a `recorded` row without who received it, how or
when; a `voucher` or `stored_value` row at all, because their ledgers do not exist yet (steps 7
and 8 replace that trigger with one that looks for the ledger entry in the same batch); a host
row with a negative amount that is not a reversal; a reversal that does not undo exactly one
applied recorded payment of the same order with a reason; a second reversal of one; and any edit
of a host row except an erase blanking its reference and reason.

**Recorded payments: `order.recordPayment`**, `{ id, amount, kind, receivedOn, reference? }`,
staff only, permission **`orders:payments`**, `actors: ["human"]` (never an assistant, an MCP
client, an automation or an extension, whatever is granted). `recorded_by` is the caller, never
input; `receivedOn` is no later than today. `orders:payments` is a core permission, admins by
default, grantable one by one by a human admin and **restricted** (ADR 0832: never to oneself,
never to a pack role's account, nothing for an AI). Every one is audited, posted on the Person's
timeline, and tells the admins when over `recordedPaymentNotice` (an order setting only a human
admin changes; 0 until set, so every one is told: the safe default, as `discountLimit`'s).
Stage 35's `invoice.recordPayment` and the till's `order.takeCash` are their own operations with
their own permissions and rules, also human only, calling the same function.

**Reversal: `order.reversePayment { paymentId, reason }`**, `orders:payments`, human only, for a
recorded payment entered in error. A second row of the amount negated naming the first (nothing is
edited or deleted); the order's paid goes down and a paid order moves back to `part_paid` as the
host (a new host move, `paid → part_paid`), its balance due now. **What the payment granted
stays**: tickets, places and moves are not undone by a reversal; staff take the right payment or
cancel the order (which voids grants and gives places back as any cancel does). A reversal leaves
an order part paid even when nothing remains paid, rather than moving it back to `pending`,
because `pending` would need every move hook to run backwards and would expire it a minute later.
Refused for a provider payment (that is a refund), for a voucher or stored value row (a refund back
onto it), for a reversal, for one already reversed, for one with money paid back on it (it was
received), and on an order that is not paid or part paid. Admins are told of every reversal.

**Refunds go back the way the money came** (amends ADR 0429). `order.refund` sends only the
provider's payments through the gatekeeper, as before (asked, approved by a person with
`orders:refund`). A recorded payment's money is paid back by a person, who records it:
**`order.recordRefund { id, paymentId, amount?, kind, reference?, reason }`**, `orders:refund`,
human only: a confirmed `core_order_refund` row of method `recorded` (the database refuses one
that is not confirmed, names no person or kind, or names no recorded payment of the order), the
order's `refunded` up, and `refunded` when everything paid has gone back. Nothing is sent, so
nothing waits in Approvals: the person with the refund permission is the one who paid it back. As
for the provider's, a part-paid order is cancelled first. Voucher and stored value refunds come
with steps 7 and 8 (provider first, then stored value, decision 13).

**Tax** (amends ADR 0479). A recorded payment carries no tax figure: the provider did not charge
it, and the host never calculates tax. How the business accounts for tax on money taken another
way is for it to confirm with its accountant.

**Erase.** A Person's orders keep their payments' amounts, methods and kinds (financial records);
a recorded payment's reference, a reversal's reason and a recorded refund's reference are blanked,
and the audit log's copies of `order.recordPayment`, `order.reversePayment` and
`order.recordRefund` on their orders are redacted.

## Consequences
- Two doors into paid, both functions, both reaching `changeOrder` only through `settle` with
  mover `host`. A test calls every actor against `order.recordPayment` and the guard.
- Stage 35 and the till add operations, not columns: an invoice's recorded payment is a `recorded`
  row; cash is `recorded` / `cash` (the till's session may add a column of its own).
- A drop-in paid by a recorded payment whose refund the host owes (ADR 0560) is not sent: the
  owed refund is skipped with the reason "taken another way: pay it back and record it", and staff
  record it with `order.recordRefund`.
- Not yet: the staff screen's "Record a payment" (step 10, with stage 47's screens).
