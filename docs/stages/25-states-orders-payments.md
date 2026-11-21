# Stage 25: States, orders and payments

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Behaviours), [`CONTEXT.md`](../../CONTEXT.md), ADR
[0404](../adr/0404-behaviours-are-the-vocabulary.md), [stage 22](22-customers-and-audiences.md),
and ADRs 0007, 0018, 0022, 0100, `docs/stages/06-integrations.md`,
`docs/integrations.md`, `packages/gatekeeper-kit`, `packages/gatekeeper-webhook`,
`packages/core/src/records/stages.ts`, `packages/sdk/src/behaviour.ts`.

Status: **spec agreed** (interview 2026-11-20). Builds on stages 20 and 22. **First half built**
(the engine, `states`, `stages` on the engine; ADR 0425), reviewed 2026-11-21 and amended below.
The second half waits for stage 22.

## Goal

The platform can take money for something and know for certain whether it was paid. An object can
declare a small state machine and the host holds it to the allowed moves. An **Order** is a base
record with lines and a state that only the payment provider's word can move to paid. Anyone can
buy, with or without an account, on the provider's own page; a refund is a staff action that goes
through approval like any other outside action.

## What exists today (from the code)

- **`stages`** (ADR 0100) is the one behaviour: a relation to a stage record, required fields per
  stage, history in `core_stage_history`, enforced inside `record.create` and `record.update` and
  simulated for the approval queue. Stages are data: an admin edits pipelines and stages in
  Settings.
- **Gatekeepers** (ADR 0007) are the only way out of a deployment: one Worker per outside service,
  holding its account and credentials, offering capability APIs, actions and simulation.
- **Inbound webhooks** arrive at `gatekeeper-webhook`, which verifies signatures, keeps seen ids
  and delivers typed events to the host, where they become automation triggers.
- **Nothing takes money.** The hosted CRM's own billing (stage 10) is in the control plane, outside
  deployments, and is not this.
- A tool's calls are separate operations, not one transaction.
- After stage 22: customer and public principals, the visibility seam, and the rule that an outside
  caller reads and writes only through the seam's helpers.

## Decided at the interview (2026-11-20)

| Question | Decision |
| --- | --- |
| The provider | **Stripe** first, behind a provider-neutral interface |
| Whose merchant account | **The company's own.** The platform never holds money |
| Where the card is typed | On the provider's hosted page |
| Order | A **base record in core**, used by every pack that sells |
| Buying without an account | **Yes.** A Person is matched or created from the email given; the account can be claimed later |
| How long an unpaid order lasts | 15 minutes by default, as a product setting |
| A payment that arrives after expiry | Staff are notified and decide: honour it or refund it |
| Who can refund | Staff with a refund permission. An AI may propose one; a person approves |
| Currency | One per deployment |
| `stages` and `states` | **One engine, two declarations.** `stages` moves onto the engine in this stage |
| Paying by deposit (added 2026-11-21, stage 27 interview) | **A deposit now and the balance by a date.** The buyer pays the rest from a link, in one go or in parts. No card is stored and nothing is charged automatically. Past the date, staff are told and decide |
| A fee line at checkout | **None.** The price is the price |
| Left out | Recurring payments and stored cards; tax and invoices beyond the provider's receipt; discounts, promo codes and gift cards; payments taken in person; a second provider |

## Scope

### The transition engine, and `states`
- One engine in the host answers, for any record with a lifecycle: is this move allowed, which
  fields does it require, who may make it, and it writes the history row and the timeline post in
  the write's own batch. It runs inside the record operations and CSV import and is simulated for
  the approval queue, as stage rules are today.
- **`states`** is the declared form. An object names the field holding the state (a single
  select), the initial state, the allowed moves, and for each move who may make it (`staff`,
  `customer`, `host`), the fields it requires, and whether it is final. A move is from one state
  to another; `final` marks the state entered, and nothing leaves a final state. A record created
  outside the initial state is judged as a move from the initial state.
- A move not declared is refused with `invalid_input` and details naming the rule, the state and
  the missing field. It holds for every actor and in the approval queue's dry run.
- A move marked `host` can be made only by platform code (a payment confirmation, an expiry). No
  person, MCP client, extension or import can make it.
- **`stages`** stays the data-driven form: pipelines and stages are records an admin edits. It
  keeps its declaration and every rule in ADR 0100, and runs on the same engine. A stage move is
  for `staff` and `host` only: a customer never moves a record through a pipeline.
- **One history table.** `core_stage_history` becomes `core_transition_history`, the engine's
  history for both forms, by one migration that keeps every existing row. `rec_stage_history` keeps its name, columns and
  numbers for stage-driven objects, so Deals' `stageMetrics` and its dashboards read as before; a
  `rec_state_history` view serves state-driven objects.

### Orders
- **`core_order`**: the customer (a Person), the email the order was placed with, the currency,
  the total, the state, the provider's reference, and when it was paid or refunded.
  **`core_order_line`**: what is bought (a relation to any record whose object is sellable), the
  quantity, the unit price and the line total.
- An order's state machine is fixed in core: `pending` → `paid` → `refunded`, `pending` →
  `cancelled`, `pending` → `expired`, and `expired` → `paid` for a late payment staff choose to
  honour. `paid`, `refunded` and `expired` are `host` moves. `expired` is therefore not final.
- Prices are read from the records being bought when the order is created, by the host. A caller
  never sends a price or a total.
- **One currency per deployment,** set in the product's settings by a human admin. Every order
  stores it. A record priced in another currency cannot be put on an order.
- An order is its Person's: it declares `customer`, so stage 22's seam lets a customer read their
  own orders and nobody else's.
- When an order becomes paid, the host raises an `order.paid` record event with its lines. Packs
  act on it through an automation or, where it must be in the same batch, through the `sellable`
  behaviour stage 27 adds. This stage ships the event and a fixture that consumes it.
- A pending order with no payment expires after a set time, 15 minutes by default, by the minute
  cron. The time is a product setting.

### Paying by deposit
Added after the stage 27 interview: the first thing sold (a training camp) is paid by a deposit
and a balance due by a date. The decisions on how it works are the coordinator's and can be
overridden.

- A sellable record may offer a deposit: an amount, and the date the balance is due. Stage 27's
  `sellable` declares the fields; this stage's orders carry them. `order.start` takes
  `pay: "full" | "deposit"`, and the host works out what is due now. A caller never sends an
  amount for the first payment.
- An order records what has been paid. The state machine gains **`part_paid`**: `pending` →
  `part_paid` → `paid`, both `host` moves made only by a verified payment, and `part_paid` →
  `cancelled` by staff.
- **The place is theirs from the first payment.** The move to `part_paid` raises `order.paid`'s
  sibling event `order.partPaid` and, from stage 26, confirms the order's holds, exactly as `paid`
  does for an order paid in full. What was granted (stage 27's tickets) is granted then.
- A `part_paid` order does not expire by the 15-minute clock. It has a **balance due date**.
- **Paying the rest:** `order.checkout` on a `part_paid` order takes an amount, at least a set
  minimum and at most the balance, and returns the provider's page as before. Each verified
  payment adds to what is paid; when nothing is owed the order is `paid`. The buyer reaches it
  from their account or from the order's signed link, which for a `part_paid` order lasts until
  it is paid or cancelled.
- **Past the due date** nothing moves by itself. The order shows as overdue on a list in the
  admin and staff are notified, daily, until they extend the date (`order.extendBalanceDue`),
  cancel it (which releases its places and leaves any refund of what was paid to the refund
  flow) or it is paid.
- No card is stored, and no instalment is scheduled or charged automatically.

### Buying without an account
- `order.start` is open to customers and the public. A public caller gives an email address.
- The address is matched to a Person by the "same email" rule stage 22 uses. One match: the order
  is that Person's. None: a Person is created. Several: the order keeps the address, belongs to no
  Person yet, and staff are notified to merge; it can still be paid.
- A guest never reads a Person. They see their own order through a link in the confirmation
  email, which carries a signed token for that one order and expires.
- When someone later signs in with that address, verified by a code, the orders placed with it
  are already theirs, because they belong to the same Person.
- The erased-address list is checked before an order is started.

### The payments gatekeeper
- `gatekeeper-payments` with one provider, Stripe, behind a provider-neutral interface: create a
  checkout for an order, read a payment, refund a payment.
- **The org connects its own Stripe account** in Settings → Integrations, as with other
  gatekeepers. Keys live in the gatekeeper and never in the host or a client app. Money goes from
  the buyer to the org; the platform is never in its path.
- **Paying happens on the provider's hosted page.** The platform never sees or stores card details.
- `order.checkout { orderId, returnUrl }` (customer, public) returns the provider's page address.
  `returnUrl` must be on an origin listed in the deployment's settings.
- The provider's webhook is verified by the gatekeeper and delivered to the host, which finds the
  order by the provider's reference, checks the amount and currency against the order, and makes
  the `paid` move. A delivery seen before is ignored. An amount that does not match moves nothing
  and notifies staff.
- The return page never marks an order paid. Only the verified webhook does.

### A payment after expiry
- A verified payment for an order that has already expired does not make it paid. Staff are
  notified, and the order shows as **paid late**.
- Staff then either honour it (`order.honourLate`, which makes the `paid` move and, from stage 26,
  claims the places if they remain) or refund it. Until one happens it stays on a list in the
  admin and notifies daily.

### Refunds
- `order.refund { orderId, amount?, reason }` needs a new permission, `orders:refund`, has risk
  class `outbound`, and goes through the approval pipeline with a simulation saying what will be
  sent back and to which payment.
- An AI actor can propose a refund. A person with the permission approves it; policy cannot be
  set to let an AI approve one.
- The order moves to `refunded` when the provider confirms, by webhook.
- Partial refunds are recorded as amounts on the order; the state is `refunded` only when the full
  amount has gone back.

### Staff and AI
- Orders appear in the admin as a base record with list, record page and saved views.
- `rec_order` and `rec_order_line` views are available to `query.sql` and dashboards.

## Out of scope
- Recurring payments, stored payment methods, subscriptions, retries (stage 32).
- Tax, and invoices or receipts beyond the provider's own. Prices are what the buyer pays; whether
  they include tax is the org's to state in its own copy.
- Discounts, promo codes, gift cards, account credit (stage 34).
- Payments taken in person by staff: cash, a card reader.
- A second provider.
- A platform merchant account or any share of a payment.
- Capacity and holds (stage 26). In this stage nothing stops two orders for the last place.

## Acceptance criteria
1. **States:** a fixture object with a state machine refuses an undeclared move, a move missing a
   required field and a `host` move by a person, an MCP client, an extension and an import, each
   with the specified details; allowed moves write history in the same batch.
2. **Stages on the engine:** Deals' existing tests pass unchanged. On the seeded data,
   `rec_stage_history` returns the same rows and `stageMetrics` the same numbers before and after.
   Every row that was in `core_stage_history` survives the migration. (As built: Deals' tests
   are unchanged except the table's name in two queries.)
3. **Prices are the host's:** an order created with a tampered price or total in the input is
   priced from the records, and a test asserts the input schema has no price field.
4. **Paid only by webhook:** with a fake provider, the return page alone leaves the order
   `pending`; a verified webhook makes it `paid`; the same webhook delivered again changes
   nothing; an unverified one is refused by the gatekeeper.
5. **Mismatch:** a webhook with a different amount or currency leaves the order `pending` and
   notifies staff.
6. **Expiry and late payment:** a pending order past its time becomes `expired`; a payment for it
   leaves it unpaid, shows it as paid late and notifies staff; `order.honourLate` and a refund
   each clear it.
7. **Guest checkout:** a public caller starts and pays an order with an email; one match links to
   that Person, none creates one, several link none and notify staff; the emailed link shows that
   order only and stops working after its expiry; signing in later with the address shows the
   order.
8. **Refund:** proposed, simulated, approved and sent; refused without `orders:refund`; an AI
   actor cannot approve one under any policy; the order is `refunded` only after the provider's
   confirmation; a partial refund records the amount.
9. **Currency:** an order in the deployment's currency succeeds; a line priced in another is
   refused.
10. **Isolation:** the stage 22 isolation test covers orders and order lines, and a guest's token
    for one order reads no other.
11. **No card data:** no table, log line or audit row holds a card number, checked by a test that
    scans what a full checkout wrote.
12. **Event:** `order.paid` reaches a fixture automation once per order.
12a. **Deposit:** an order started with `pay: "deposit"` is due the record's deposit, priced by
    the host; a verified payment of it makes the order `part_paid` and does not expire it; a
    second payment for part of the balance leaves it `part_paid` with the right amount owing; a
    payment of the rest makes it `paid`; a checkout for more than the balance is refused; past
    the due date it is listed as overdue and staff are notified, and nothing else changes;
    extending the date and cancelling both work, and cancelling releases the fixture's hold.
13. `pnpm lint typecheck test` and e2e (start an order as a guest, pay it against the fake
    provider, refund it) pass in CI. ADRs, `CONTEXT.md` (Order, and Behaviour amended) and
    `docs/architecture.md` are updated.

## Dependencies
- Stage 22, merged.
- Independent of stages 23 and 24: it is testable through `invoke()`.

## Migrations and numbers
Migrations 0420 to 0439. ADRs 0425 to 0429.

## Suggested build order
1. The transition engine and `states`, with history, against fixture objects.
2. Orders and lines, priced by the host, with the fixed state machine and the currency setting.
3. The payments gatekeeper against a fake provider; checkout and the webhook.
4. Guest checkout: the email match, the order link.
5. Expiry and the late-payment path.
6. Refunds through approval, with the new permission.
7. Stripe in test mode, by hand, with a runbook.
8. `stages` onto the engine and the one history table, as its own commit.

Steps 1 to 4 are the spine: the engine every later behaviour stands on, the rule that only a
verified payment marks an order paid, and the first operations open to the public.

## What the second half needs from the engine (from the first half's review)
- **The author of a move comes from the principal.** The engine reads `ctx.user.id` for
  `entered_by`. Stage 22 makes `ctx.user` throw for a customer's or the public's call, so a move by
  one of them is written with no `entered_by` and `entered_as: "customer"`.
- **A customer mover.** Stage 22's customer principal answers `customer`; until then every caller
  of an operation is `staff`.
- **Core objects.** `updateRecordAsHost` handles extension objects only, and state titles come
  from an extension field's choices. Orders are a base record, so both need a core path.
- **A hook when a record moves,** for platform code only and in the write's batch, for
  `order.paid` and stage 27's `sellable`.
- **Erase.** `core_transition_history` joins the erase stores (ADR 0320).

## The second half's spine, as built (2026-11-21)
Orders, the verified-payment rule, deposits and guest checkout are built (ADRs 0426 to 0428,
migration 0421). Where the build read the spec one way, or decided what it left open:

- **Order and Order line are in the registry but not in the generic object list,** so search,
  embeddings, summaries and extension fields do not pick them up, and the generic record writes
  refuse them (ADR 0427).
- **`order.start` is also open to staff,** with an email address, so the admin can place an order
  for someone.
- **A guest's token is random and stored as a hash,** not signed: a handler has no signing
  secret. `order.view { id, token }` is the guest's read; `order.get` is the seam's (ADR 0428).
- **A tampered price is ignored, not refused:** unknown input keys are dropped, and the order is
  priced from the records, as criterion 3 says.
- **`order.paid` and `order.partPaid` are the order's `updated` record event** whose diff moves
  `state`. A first-class event name for automations is left to the gatekeeper half if criterion
  12's fixture needs one.
- **Who may cancel:** a customer, their own order while nothing is paid on it; staff, also a
  part-paid one. `expired` is the host's move.
- **A part payment** is at least a set minimum (`order_min_part_payment`, default 10.00), or the
  balance when less is owed.
- **A deposit order's due date** is the earliest of its lines' dates, and its deposit the sum of
  theirs.
- **An order is written from a current read** (a version column and a trigger), so two payments
  at once cannot both be judged against the same read.
- **An erased Person's orders are kept without the person,** the address or the guest's token.
- **Holds are not wired.** `createOrder` and `orders/holds.ts` mark where stage 26's claims,
  confirms and releases go.

Still to build: `gatekeeper-payments` and the fake provider, `order.checkout`, the webhook route
that calls `applyVerifiedPayment`, the expiry sweep, `order.honourLate`, refunds through approval
with `orders:refund`, the confirmation email with the guest's link, the admin screens, the Stripe
runbook and the e2e test.

## Notes for the build
- Before taking payment inside a phone app, read Apple's and Google's current rules on which
  purchases may use an outside payment page. Event tickets and classes are goods and services
  used outside the app, which have been allowed; anything digital may not be.
- Stripe's current fees were not checked for this spec.
