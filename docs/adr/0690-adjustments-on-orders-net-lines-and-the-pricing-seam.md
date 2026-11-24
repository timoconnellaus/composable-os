# ADR 0690: Adjustments on orders: net lines, the total after adjustments, the pricing seam

Status: accepted, 2026-11-24 (stage 34, build step 1; [the spec](../stages/34-offers.md)).
Amends [ADR 0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md)
(orders priced by the host) and [ADR 0479](0479-tax-at-checkout.md) (tax at checkout).

## Context
Stage 34 gives money off everywhere a business sells: promo codes, members' prices, staff
discounts at the desk, referral deals. Until now an order's total was the sum of its lines' prices
and nothing could lower it. The spec weighed and rejected the provider's own promo codes (the
provider would decide the price), a negative-priced "discount line" (it breaks the tax split, line
refunds, "nothing to pay" and every report that sums lines) and a pack hooking order pricing (a new
behaviour is platform work, ADR 0404). Every later step of the stage (codes, members' prices,
referrals) and stage 35's quotes read what this step decides.

## Decision

**An adjustment is a core row on an order.** `core_order_adjustment` (migration 0950): the order,
the line it is on (null: the whole order), its kind (`code`, `automatic`, `staff`, `referral`), the
discount record it came from or the person who gave it, why, the percentage asked when it was one,
the amount (positive minor units), the approval it waited in, and when. A trigger keeps a row as it
was given: only `removed_at` / `removed_by` may be set, once (an adjustment taken off a pending
order), and a reason may be blanked (erase); a row is never deleted, and one is added only to a
pending order.

**Net lines, and the total after adjustments.** `core_order_line.line_total` stays the line's
price; `line_discount` is its share of the adjustments (never more than the line). The order's
`total` is what is owed after adjustments, and `discount` is their sum (`core_order_stale` now
covers it). So everything that already reads the total reads the net with no change: `chargeFor`,
the amount a verified payment must match (ADR 0427's rule holds as built), the balance, and what a
refund can give back (what was paid, per payment, so a refund owed for a discounted drop-in is the
net it paid).

**The pricing seam.** An order is priced in one place: `priceLines` reads each record's price (as
before), then `applyAdjustments` (`orders/adjustments.ts`) takes the adjustments off in the order
they were made: one on a line from that line, one on the order spread over the lines by what each
still costs (`splitInProportion`), whole minor units that always sum, no line below nothing. A
percentage is rounded down on each line. `createOrder` prices through it (nothing is taken off at
the start in this step), and every change to a pending order's adjustments reprices the order
through it from its lines' prices and every adjustment still on it, so the lines and the total are
always the same function of the prices and the adjustments. The deal of a code or a member's price
(the `discount` behaviour, a later step) joins this stage, and stage 37's delivery line follows it;
its public dry run `order.quote` will call the same functions.

**Tax** (amends ADR 0479). The checkout's payment is split over the lines in proportion to their
**net** (`line_total - line_discount`), so the provider is sent each line's net share with its code
and taxes what it charges. The host still never calculates tax; whether a discount reduces the
taxable amount is the business's to confirm with its accountant.

**Deposits.** The deposit stays what the records say and a discount comes off the balance. A
deposit a discount leaves at or above the total is not taken: `chargeFor` asks for the whole total
and the order is paid in full.

**Changing a price only before the checkout opens.** An adjustment is added to or taken off only
a pending order whose checkout has not opened (`rule: "checkout_open"`): a provider page already
open was made for the old amount.

**Nothing to pay is not reachable yet.** An adjustment that would take the order to nothing is
refused (`rule: "total"`): an order with nothing to pay has no way to be paid until the stage's
"order paid another way" step adds one. The spec lets a person's staff adjustment make an order
free; that waits for that step.

**Reports.** `rec_order` gains `discount`; `rec_order_line` gains `line_discount` and `line_net`;
`rec_order_adjustment` lists adjustments with their order's Person, state and currency. The order
and line objects gain `discount` (and the line `netTotal`), readable by the order's customer; the
adjustments themselves (who gave one and why) are staff only (`order.get` for staff).

**Erase.** A Person's orders keep their adjustments' amounts, kinds and sources (the order is a
financial record); a staff reason is blanked.

## Consequences
- No operation takes an order's price from its input still: the only amount a caller names is a
  staff discount's (ADR 0691), money off within a limit a human admin set or approved by one.
- Any later source of money off (a code, a member's price, a referral deal) is an adjustment row
  and a stage of `applyAdjustments`, never a hook and never a line.
- A report that sums `line_total` sums prices before discounts; `line_net` (or the order's
  `total`) is what was charged.

## Proof
`packages/core/test/order-adjustments.test.ts`: the spread sums and never takes a line below
nothing; a percentage discount's lines, total and adjustment row; the checkout asks for the net and
the verified payment of the net makes the order paid; with tax on, the provider's shares are the
net lines and sum to the charge (criterion 2); a deposit order keeps its deposit and its balance
drops (criterion 9); a refund asks for the net paid; the database refuses changing an adjustment's
amount, deleting one and adding one to an order that is not pending; erase blanks a reason and
keeps the amount; a discount on an order of 50 lines runs about 55 statements, each binding fewer
than 100 values.
