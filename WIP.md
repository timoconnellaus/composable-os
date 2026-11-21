# WIP: stage 25, second half

Branch `claude/stage-25-orders-payments`. Delete this file before the PR is final.

## Built (the spine)

Spec: `docs/stages/25-states-orders-payments.md` ("The second half's spine, as built"). ADRs 0426,
0427, 0428. Migration 0421. `CORE_SCHEMA_VERSION` 421.

- The engine: a customer is a mover, `onRecordMove` hooks, history in the erase stores.
- `packages/core/src/orders/`: `createOrder`, `changeOrder`, `chargeFor`, `overdueOrders`,
  `applyVerifiedPayment`, `resolveBuyer`, the guest token, the sellable registry, the settings.
- `packages/core/src/operations/order.ts`: `order.start`, `order.get`, `order.list`,
  `order.view`, `order.cancel`, `order.extendBalanceDue`, `order.setPerson`, `order.overdue`,
  `order.settings.get`, `order.settings.update`.
- Tests: `packages/core/test/orders.test.ts`, `states-customer.test.ts`, and the isolation suite
  (`audiences-isolation.test.ts`) now holds real orders and lines for both customers.

## To build (the gatekeeper half)

Migrations 0422 to 0439 and ADR 0429 are free in block T.

1. **`gatekeeper-payments`** with a provider-neutral interface (create a checkout for an order,
   read a payment, refund a payment) and a fake provider for tests. Stripe behind it. The org
   connects its own account in Settings → Integrations. Keys never reach the host.
2. **`order.checkout { orderId, returnUrl, amount? }`** (customer, public with the order's token,
   staff). Ask `chargeFor(row, await loadMinPartPayment(db), amount)` for what to charge; store
   the provider's reference with `changeOrder(ctx, row, row.state, { provider, provider_ref }, …)`.
   `returnUrl` must be on an allowed origin. The return page never marks an order paid.
3. **The webhook handler:** the gatekeeper verifies, then an operation only the host's adapter
   calls hands the payment to `applyVerifiedPayment(ctx, { provider, eventId, orderId, amount,
   currency, paymentRef })`. On a `conflict` with `reason: "order_stale"`, apply the event again.
   `fixture.verifiedPayment` in `packages/core/test/order-fixtures.ts` is its test double.
4. **The expiry sweep** on the minute cron: `pending` orders past `expires_at` (index
   `core_order_expiry_idx`) move to `expired` with `changeOrder(ctx, row, "expired", {}, "host")`.
   A `part_paid` order never expires.
5. **Late payment:** payments recorded with outcome `late` are the "paid late" list;
   `order.honourLate` makes `expired` → `paid` as host (and, with stage 26, claims again) or
   staff refund. Notify daily until one happens.
6. **Overdue balances:** a daily notice to staff for `order.overdue` (the query exists).
7. **Refunds** through approval with a new `orders:refund` permission; an AI may propose, never
   approve; `paid` → `refunded` as host only after the provider confirms; partial refunds record
   the amount. Refunding a cancelled part-paid order's deposit is the same flow.
8. **The confirmation email** through the email-send gatekeeper, with the guest's link (the token
   from `order.start`; it is shown once and only its hash is stored).
9. **`order.paid` / `order.partPaid` for automations** (criterion 12): today they are the order's
   `updated` record event with `state` in the diff. Add a first-class trigger if the fixture
   automation needs one.
10. **Admin:** orders list and page (`order.list`, `order.get`), the overdue and paid-late lists,
    the order settings, `order.setPerson`. A notification's link to an order has no route yet
    (`notificationHref` sends it to `/x/order/<id>`).
11. **Stage 26, when it is on main:** take claims in `createOrder` (the comment marked STAGE 26)
    and fill `orders/holds.ts`.
12. **Stage 27:** `sellable` in the manifest calls `registerSellable`; reminders before a balance
    is due.
13. The Stripe runbook, the e2e test (start as a guest, pay against the fake provider, refund),
    and criterion 11 (no card data, by scanning what a full checkout wrote).
