# ADR 0530: Plan changes: an upgrade now, applied once paid; a downgrade from the next period

Status: accepted, 2026-11-22 (stage 32b, build step 6; [the spec](../stages/32-memberships.md),
decision 12: "upgrades at once, prorated; downgrades at the next period"). Builds on ADRs
[0485](0485-recurring-billing-the-provider-runs-the-schedule.md),
[0486](0486-an-order-per-paid-period-and-its-refund.md),
[0510](0510-what-a-subscription-grants.md) and
[0022](0022-approval-queue-and-simulation.md) as amended (the dry run causes no real effect). Migration 0630.

## Context
A member on three classes a week wants unlimited now, and pays the difference; a member moving
down should not be handed back money for classes already taken. The provider runs the schedule
(decision 2), so the host must ask it to change the price and move nothing until a verified read
says it did. Stripe's own documentation was read for this (change-price, pending-updates,
prorations and the subscription update reference, 2026-11-22).

## Decision
**One operation, `subscription.change { id, planId, reason }`** (staff with
`subscriptions:manage`; a customer, their own; `actors: ["human"]`, `hostInternal`, not on MCP).
Opening it to `customer` is a reviewed change (ADR 0402): the member changes plan on the web
(decision 5), and every rule is the host's. The host prices the new plan as at the start
(`priceLines`, a plan of the same object, the same interval, on sale to a customer), and refuses
the same plan, a subscription that is not `active`, one set to end, and one with a change already
open. Which kind it is, is the host's: **dearer is an upgrade, the same or cheaper a downgrade.**

**At the payments gatekeeper**, a new action `payments.subscription.change` (never
auto-approvable; the host's own call is applied at once, an agent's session waits for a person):
- **an upgrade** (`when: "now"`): a Price on the subscription item's own product (a pending update
  takes `items[].price`, not `price_data`), then the item moved to it with
  `proration_behavior=always_invoice` and `payment_behavior=pending_if_incomplete`. The rest of the
  period is invoiced at once and the change applies only once that invoice is paid: "a member
  never gets an upgrade they did not pay for" (the spec). A declined charge leaves the old price;
  Stripe drops the pending update within 23 hours.
- **a downgrade** (`when: "next_period"`): `items[].price_data` on the same product with
  `proration_behavior=none`: nothing credited or charged now, the next invoice is the new price.
  A downgrade to the same price asks the provider nothing.
- The item's id is always sent (without it Stripe adds a second item), with quantity 1.

**What the host records** (`core_subscription_change`, migration 0630): the change as asked
(`requested`), written in the operation's batch; the gatekeeper is called **after the commit**
(`afterCommit`), so two changes asked at once ask the provider once (a unique index on the open
change refuses the second batch), and a dry run, which commits nothing, asks nothing. A call that
fails marks the row `lapsed`.

**Following it from verified reads** (`subscriptions/changes.ts`, in each event's batch):
- a read at the new price is the change asked for, not a change made at the provider (the "terms
  changed at the provider" warning of ADR 0485 is not raised for it);
- an upgrade is `applied` from the first fresh read at the new price: the subscription's plan,
  title and price become the new plan's, and what it grants follows (below);
- a downgrade is `waiting` from the read at the new price, and `applied` from the first read whose
  period starts at or after the period's end it was asked in: the member keeps the plan paid for
  until then;
- an upgrade never shown within a day reads `lapsed`, and a new change may then be asked.

**What it grants follows the plan** (ADR 0510's `followSubscriptionGrant`, `planChanged`): every
field the grant fills from the plan (`item`, `item.<field>`: the plan itself, its uses, its
period, its limits) is written again by the host when the change applies. The allowance's own
rules then hold (ADR 0493): a raised limit applies to the period running; a lowered one leaves a
period over its limit taking no spend; a change of period applies from the end of the one running.

**Orders.** The upgrade's prorated charge is an order for what was paid, its line the new plan
("<plan>: the rest of the period (upgrade from <plan>)"), not flagged, when it is at most the
difference in price and was asked within two days; any other amount stays flagged (ADR 0486).

## Deviations from the spec
- **The spec says "a change at the period's end is a subscription schedule".** A downgrade here is
  `proration_behavior=none` instead: Stripe's documentation says the next invoice is the new price
  with the same billing dates, and a schedule would block pauses and the portal and need a release.
  The host, not the provider, holds when the member's terms follow.
- **A change of the same price** is a downgrade the provider is not asked about (no money moves);
  the plan follows from the next period. Invoices keep the first plan's product name (the price
  moves, not the product); a later change may rename it.
- **Only an active subscription changes.** On trial or past due it is refused (a trial changes
  after it ends; a failing one is paid first).

## Consequences
- Stripe test-mode checks are added to the runbook: `items[0][price]` with
  `payment_behavior=pending_if_incomplete` and `always_invoice` on a flexible subscription; the
  invoice's `billing_reason` (read as anything: the host matches the amount); `price_data[product]`
  with `proration_behavior=none`; a pending update's expiry and the read during it.
- The fake provider prorates on the time left, applies an upgrade only once its invoice is paid
  (`card_declines`, `recover`), and applies a downgrade's price at once, charged from the renewal.
- Undoing a waiting downgrade is not built: staff end the subscription or wait for the period.
