# Stage 25: States, orders and payments

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Behaviours), [`CONTEXT.md`](../../CONTEXT.md), ADR
[0404](../adr/0404-behaviours-are-the-vocabulary.md), [stage 22](22-customers-and-audiences.md),
and ADRs 0007, 0018, 0022, 0100, `docs/stages/06-integrations.md`,
`docs/integrations.md`, `packages/gatekeeper-kit`, `packages/gatekeeper-webhook`,
`packages/core/src/records/stages.ts`, `packages/sdk/src/behaviour.ts`.

Status: spec proposed. Builds on stages 20 and 22.

## Goal

The platform can take money for something and know for certain whether it was paid. An object can
declare a small state machine and the host holds it to the allowed moves. An **Order** is a base
record with lines and a state that only the payment provider's word can move to paid. A customer
pays on the provider's own page; a refund is a staff action that goes through approval like any
other outside action.

## What exists today (from the code)

- **`stages`** (ADR 0100) is the one behaviour: a relation to a stage record, required fields per
  stage, history in `core_stage_history`, enforced inside `record.create` and `record.update` and
  simulated for the approval queue.
- **Gatekeepers** (ADR 0007) are the only way out of a deployment: one Worker per outside service,
  holding its account and credentials, offering capability APIs, actions and simulation.
- **Inbound webhooks** arrive at `gatekeeper-webhook`, which verifies signatures, keeps seen ids
  and delivers typed events to the host, where they become automation triggers.
- **Nothing takes money.** The hosted CRM's own billing (stage 10) is in the control
  plane, outside deployments, and is not this.
- A tool's calls are separate operations, not one transaction.

## Scope

### The `states` behaviour
- An object declares `states`: the field holding the state (a single select), the initial state,
  the allowed moves, and for each move who may make it (`staff`, `customer`, `host`), the fields
  it requires, and whether it is final.
- The host enforces it inside the record operations and CSV import, as it does stage rules: a move
  not declared is refused with `invalid_input` and details naming the rule, the state and the
  missing field. It holds for every actor and in the approval queue's dry run.
- A move marked `host` can be made only by platform code (a payment confirmation, an expiry). No
  person, MCP client, extension or import can make it.
- Each move writes a row to a state history table in the same batch, and posts to the timeline
  when the field is tracked.
- `stages` is unchanged. Whether it is later expressed through `states` is not this stage's.

### Orders
- **`core_order`**: the customer (a Person), the currency, the total, the state, the provider's
  reference, and when it was paid or refunded. **`core_order_line`**: what is bought (a relation
  to any record whose object is sellable), the quantity, the unit price and the line total.
- An order's state machine is fixed in core: `pending` → `paid` → `refunded`, `pending` →
  `cancelled`, `pending` → `expired`. `paid`, `refunded` and `expired` are `host` moves.
- Prices are read from the records being bought when the order is created, by the host. A caller
  never sends a price or a total.
- An order is its Person's: it declares `customer`, so stage 22's seam lets a customer read their
  own orders and nobody else's.
- When an order becomes paid, the host raises an `order.paid` record event with its lines. Packs
  act on it through an automation or, where it must be in the same batch, through the `sellable`
  behaviour stage 27 adds. This stage ships the event and a fixture that consumes it.

### The payments gatekeeper
- `gatekeeper-payments` with one provider, Stripe, behind a provider-neutral interface: create a
  checkout for an order, read a payment, refund a payment.
- The org connects its own provider account in Settings → Integrations, as with other gatekeepers.
  Keys live in the gatekeeper and never in the host or a client app.
- **Paying happens on the provider's hosted page.** The platform never sees or stores card details.
- `order.checkout { orderId, returnUrl }` (customer, public) returns the provider's page address.
  `returnUrl` must be on an origin listed in the deployment's settings.
- The provider's webhook is verified by the gatekeeper and delivered to the host, which finds the
  order by the provider's reference, checks the amount and currency against the order, and makes
  the `paid` move. A delivery seen before is ignored. An amount that does not match moves nothing
  and raises a notification to staff.
- The return page never marks an order paid. Only the verified webhook does.
- A pending order with no payment expires after a set time, by the minute cron.

### Refunds
- `order.refund { orderId, amount?, reason }` is staff-only, risk class `outbound`, and goes
  through the approval pipeline with a simulation saying what will be sent back and to which
  payment.
- The order moves to `refunded` when the provider confirms, by webhook.
- Partial refunds are recorded as amounts on the order; the state is `refunded` only when the full
  amount has gone back.

### Staff and AI
- Orders appear in the admin as a base record with list, record page and saved views.
- `rec_order` and `rec_order_line` views are available to `query.sql` and dashboards.
- An AI actor can read orders and propose a refund; it cannot approve one unless policy allows,
  as with any `outbound` action.

## Out of scope
- Recurring payments, stored payment methods, subscriptions, retries.
- Tax, invoices, receipts beyond the provider's own.
- Discounts, promo codes, gift cards, account credit.
- A second provider.
- Capacity and holds (stage 26). In this stage nothing stops two orders for the last place.
- Point of sale, cash, payments taken by staff.

## Acceptance criteria
1. **States:** a fixture object with a state machine refuses an undeclared move, a move missing a
   required field and a `host` move by a person, an MCP client, an extension and an import, each
   with the specified details; allowed moves write history in the same batch.
2. **Prices are the host's:** an order created with a tampered price or total in the input is
   priced from the records, and a test asserts the input schema has no price field.
3. **Paid only by webhook:** with a fake provider, the return page alone leaves the order
   `pending`; a verified webhook makes it `paid`; the same webhook delivered again changes
   nothing; an unverified one is refused by the gatekeeper.
4. **Mismatch:** a webhook with a different amount or currency leaves the order `pending` and
   notifies staff.
5. **Expiry:** a pending order past its time becomes `expired`, and a late payment for it is
   flagged to staff, not silently accepted.
6. **Refund:** proposed, simulated, approved and sent; the order is `refunded` only after the
   provider's confirmation; a partial refund records the amount.
7. **Isolation:** the stage 22 isolation test covers orders and order lines.
8. **No card data:** no table, log line or audit row holds a card number, checked by a test that
   scans what a full checkout wrote.
9. **Event:** `order.paid` reaches a fixture automation once per order.
10. `pnpm lint typecheck test` and e2e (create an order, pay it against the fake provider, refund
    it) pass in CI. ADRs, `CONTEXT.md` (Order, and Behaviour amended) and `docs/architecture.md`
    are updated.

## Dependencies
- Stage 22 for customer and public callers.
- Independent of stages 23 and 24: it is testable through `invoke()`.

## Migrations and numbers
Migrations 0420 to 0439. ADRs 0425 to 0429.

## Suggested build order
1. `states` in the SDK and the host, with history, against fixture objects.
2. Orders and lines, priced by the host, with the fixed state machine.
3. The payments gatekeeper against a fake provider; checkout and the webhook.
4. Expiry and the mismatch path.
5. Refunds through approval.
6. Stripe in test mode, by hand, with a runbook.

## To settle at the interview
- **Stripe first, or another provider.** Ghetto pays through Mindbody today; which processor it
  can use, and its fees, should be checked before building.
- **Hosted page or embedded fields.** Hosted is proposed: nothing sensitive touches the platform.
  Embedded looks more native in an app.
- **Is Order a base record in core, or a pack?** Core is proposed, because several packs sell
  things and money rules should not be per pack.
- **Who is the merchant.** The org, with its own provider account, as proposed. A platform account
  taking a share is a different business and a different compliance position.
- **Guest checkout.** Can a visitor buy without an account, with a Person created from the
  provider's verified email afterwards?
- **How long a pending order lives.**
