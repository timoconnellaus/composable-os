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
- Undoing a waiting downgrade: staff withdraw it (amended below).

## Amended after review (2026-11-22, before merge)
An independent review found the host kept trusting a change after it should have stopped, and
closed one on an answer that did not say whether it happened. Each is fixed, with a test that fails
without it (`packages/core/test/subscription-changes.test.ts`, "the review of 32b").
- **One definition of open.** A change is open while it is `requested` or `waiting` and before its
  `expires_at`: a day after it was asked (the provider drops a pending update within 23 hours), a
  week after a waiting downgrade's period end. `openChange` returns it open or stale; every reader
  (the read's price taken as agreed, `followChange`, the proration match, the declined-upgrade
  words) uses only the open one, and the reader's batch closes a stale one as `lapsed`. The view's
  `change_state` says the same in SQL. An upgrade never paid cannot later turn a coupon renewal
  into its "proration", nor a price edited at the provider into the upgrade.
- **A proration is the provider's subscription-update invoice**: `billing_reason`
  `subscription_update`, at most the difference in price, for an open upgrade or one applied in
  the last two days (one equal to the old price is matched). A paid update invoice with no upgrade
  to take it tells staff for each invoice. Stripe applies a pending update when its invoice is paid
  (docs.stripe.com/billing/subscriptions/pending-updates), so its read then shows the new price,
  which the host reports as a change at the provider.
- **What came of the call is kept, audited.** The host's own call now returns which actions applied
  and, for one that failed, the gatekeeper's words (`IntegrationCallResult.failed`). The change
  records `sent`, `pending`, `unknown` or `refused` (`call_outcome`), with an audit row
  (`subscription.change.outcome`). Only a refusal ("nothing changed", the gatekeeper's
  `ActionApplyError`) closes it; an unknown outcome, or a call that failed on the way, leaves it
  open for verified reads to decide until it expires, shown to staff and the payer.
- **`subscription.change.withdraw`** (staff, `subscriptions:manage`, a person only) closes a change
  stuck asked, unknown, or a downgrade waiting (undoing it). A downgrade the provider may show is put
  back there through the gatekeeper (the old price from the next invoice, nothing prorated); an
  upgrade's pending update is left to expire. A waiting downgrade whose price is put back at the
  provider is closed by the read.
- **A downgrade's date is the provider's**: the end of the period of the verified read that shows
  its price, not the period the host had when it was asked; and any change is refused while the
  host's period has ended and the renewal has not arrived.
- **An upgrade whose charge needs the payer to confirm it** (3D Secure) keeps the provider's page on
  the change (`actionUrl`), shown in the member's block as "Confirm the new plan's payment".
- **The gatekeeper takes plan changes, pauses and their end only from the host's own call**
  (`isHostOrders`, as the portal): the host writes what it asks before asking, so one asked another
  way would be a change it never asked for. An agent's session is refused before anything is queued.
- A change of a subscription with nothing to pay is refused before anything is written.

## Amended after the second review (2026-11-22, before merge)
Each item has a test that fails without it (`subscription-changes.test.ts`, "the second review of
32b"; the gatekeeper's and the runner's tests).
- **A withdraw closes the change only once its undo is sent.** A downgrade's put-back, or an
  upgrade's void (below), is asked after the commit; until the gatekeeper says it was sent the
  change stays open, showing what came of it (`end_outcome`), and staff ask again. With nothing at
  the provider to undo it is closed in the operation's batch.
- **Withdrawing an upgrade voids its pending update's invoice** (`payments.subscription.void_update`,
  the host's own call only; docs.stripe.com/billing/subscriptions/pending-updates: "To cancel a
  pending update, you need to void the invoice the update created", the subscription's
  `latest_invoice`; docs.stripe.com/api/invoices/void, finalized invoices only, "This cannot be
  undone"). Refused, nothing changed, when no update is pending with an open invoice.
- **A late event is followed as its change.** The short life still decides what may be claimed and
  what a reader takes as agreed in advance; a verified read that arrives after a change lapsed, and
  shows it, is followed as that change for 3 days after its life ended (`lateChange`): a downgrade
  when the read shows its price, a pause when it shows paused, an upgrade only with its
  subscription-update invoice paid in that event (at most the price difference). A refused or
  withdrawn change is never revived.
- **A downgrade's first period is decided by the renewal.** A renewal invoice in the event for the
  read's period (`billing_reason` `subscription_cycle`) says it: billed at the new price, the member
  holds the new plan from that period; at the old one, from its end. With no such invoice, a read
  period begun after the change was asked is the first at the new price (it was invoiced after the
  provider took it); one begun before, the next.
- **A lost renewal event no longer blocks a change.** When the host's period has ended, the
  subscription is read once at the provider through the gatekeeper (an observation, as the host),
  and the change goes on from that period if it is active as agreed; the host's record is not
  moved by that read.
- **A schedule left by a pause** is released before a plan change or a new pause, when every pause
  on it has resumed and the host made it (`metadata.cos_pause`); one with a pause still to come, or
  one the host did not make, refuses the change (nothing changed). Stripe: a phase change discards a
  pending update and voids its invoice, so a change under a schedule is not made.
- **The outcome is typed.** The gatekeeper puts what came of a failed action in front of its
  message, `[apply-outcome:refused|unknown|retryable] ` (RPC carries an error's message, not its
  class); the integration host reads it into `IntegrationCallResult.failed[].outcome`
  (`integrations/outcome.ts`). A retryable failure sent nothing and is read as refused.
- **The outcome's audit says what was written**: the conditional update runs first, and the audit
  row says `written: false` when the change had moved on.
- **An upgrade's confirm-payment page** is shown only while it is open; closing it clears it.
- **Erasure** blanks the reasons on the changes of the Person's subscriptions as payer or holder,
  and of a guest's known only by the address it was started with.
- Migration 0630 was edited in place while unmerged: a preview database that applied an earlier
  version must be rebuilt.
