# @composable-os/gatekeeper-payments

The payments gatekeeper (Worker `cos-gatekeeper-payments`), part of stage 25 (orders and payments).
It is provider-neutral: the org takes money on the payment provider's own hosted page, and this
Worker opens that page, reads its outcome, submits refunds for approval and delivers the provider's
verified payment and refund events to the hook the CRM's integration host bound.

- **Keys are Worker secrets of this gatekeeper only.** The Stripe secret key and webhook signing
  secret are set on `cos-gatekeeper-payments` and never leave it. The host, the CRM and extension
  code never see them.
- **Card details never reach this Worker or the CRM.** The customer types them on the provider's
  page. This Worker sees only amounts, currencies, the host's ids and the provider's references.

One real provider (Stripe) and one fake provider for development and tests, behind one interface
(`PaymentProvider` in [`src/provider.ts`](src/provider.ts)). It is auto-provisioned (no connect
flow).

## Exports

| Export | What it is |
| --- | --- |
| `GatekeeperVendor` (also the default export) | The vendor entrypoint. Its `fetch` serves the public routes. `describe()` reports `displayName: "Payments"`, `autoProvisionsAccount: true`, `providesAuth: false`; `createAccount()` mints a `PaymentsAccount`; `connectAccount()` throws. |
| `PaymentsAccount` | The account (`GatekeeperUser`). `getGatekeeperClassFor("payments://merchant/<provider>")` returns the facet class; `startResourceConfigurator("payments://merchant/:provider")` returns `{ iframeHtml, ui }`. |
| `PaymentsGatekeeper` | The per-provider gatekeeper facet (Durable Object class, `Gatekeeper<PaymentsSession>`, props `{ provider }`). Holds the refund action journal. |
| `PaymentsHookController` | The `HookController` the session passes to `bindHook()` (props `{ provider }`). |
| `PaymentsEvents` | The Durable Object per provider (`idFromName(provider)`): seen event ids, recent events, the hook's initiator and its delivery queue. |
| `FakePaymentsLedger` | The fake provider's books (`idFromName("fake")`): checkouts and refunds. |
| `PaymentsVerifier` | The trivial `GatekeeperUserVerifier` (every collaborator may observe). |
| `PaymentsConfiguratorUi` | The configurator's `ui` capability. |

The agent- and host-facing types are in [`src/types.d.ts`](src/types.d.ts) (also exported as
`@composable-os/gatekeeper-payments/types`), served by `getTypeScriptTypes()`.

## Resource

One grantable type, **Payment account**, URL pattern `payments://merchant/:provider`:
`payments://merchant/stripe` or `payments://merchant/fake`. The suggested binding name is
`PAYMENTS`, the session type `PaymentsSession`, the hook type `PaymentsEventHook`.

`getGatekeeperClassFor` refuses `fake` unless `PAYMENTS_FAKE_PROVIDER` is `"true"`, and `stripe`
unless the `STRIPE_SECRET_KEY` secret is set, each with an error saying what to set.

The configurator `ui` has `providers()` → `[{ name, title, available }]` (never a key) and
`resourceUrl(provider)`. The iframe is an inert fallback; there is no configurator spec module.

## Routes

All under `BASE_URL` (trailing slashes stripped), served by the default entrypoint's `fetch`. The
CRM proxies `https://<crm-origin>/gatekeeper/payments/*` here. A request outside the base path, or
to an unknown path, is `404`.

| Route | Answer |
| --- | --- |
| `POST {base}/in/stripe` | The Stripe webhook. See below. |
| `POST {base}/in/fake` | The fake provider's webhook (fake on only, else `404`). |
| `GET {base}/fake/pay/:ref` | The fake hosted page (fake on only). `404` for an unknown ref. |
| `POST {base}/fake/pay/:ref` | Pay or cancel on the fake page (fake on only). |
| (no route) | The fake ledger is read only through its own binding: a route would show every checkout and its return address (a guest's order link) on a public staging host (ADR 0458). |

Webhook answers:

| Answer | When |
| --- | --- |
| `200 {"ok":true}` | Verified, stored and queued for the hook (if one is enabled). |
| `200 {"ok":true,"duplicate":true}` | Verified, but the provider event id was seen before: acknowledged, not delivered again. |
| `200 {"ok":true,"ignored":true}` | Verified, but an event type this gatekeeper does not map. Nothing is stored. |
| `401 {"ok":false,"error":"<reason>"}` | Missing, malformed or wrong signature, a timestamp more than 300 s from now, an unparseable body, or no signing secret configured. Nothing is stored or delivered. |
| `405` | Not a POST. |
| `413` | Body over 256 KB (by `Content-Length` or as streamed). |

### Signatures

Both webhooks use Stripe's scheme: a header `t=<unix seconds>,v1=<hex>[,v1=<hex>…]` carrying
HMAC-SHA256 over `${t}.${rawBody}`, keyed with the secret's UTF-8 bytes. Any `v1` may match; other
keys are ignored. The comparison is constant time (`crypto.subtle.verify`).

| Route | Header | Secret |
| --- | --- | --- |
| `/in/stripe` | `Stripe-Signature` | `STRIPE_WEBHOOK_SECRET` |
| `/in/fake` | `X-Fake-Signature` | the `FAKE_WEBHOOK_SECRET` secret, or `fake-payments-dev-secret` when unset (localhost only) |

### Stripe events

| Stripe event | Becomes |
| --- | --- |
| `checkout.session.completed` with `payment_status: "paid"`, and `checkout.session.async_payment_succeeded` | a `payment` event: `orderId` from `client_reference_id`, else `metadata.order_id` (skipped when neither), `checkoutRef` the session id, `amount` `amount_total`, `paymentRef` the `payment_intent` id |
| `refund.created` and `refund.updated` with `status: "succeeded"` | a `refund` event: `orderId` from `metadata.order_id`, `refundId` from `metadata.cos_refund_id`, `refundRef` the refund id, `paymentRef` the `payment_intent` id |
| `checkout.session.completed` with `mode: "subscription"`; `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`, `.trial_will_end`; `invoice.paid`, `.payment_failed`, `.payment_action_required`, `.finalization_failed` of a subscription's invoice | a `subscription` event built from a read made now (above); only the ids are taken from the payload |
| `credit_note.created` with one refund | a `refund` event with `creditNote: true` and the credit note's `total_taxes` as `tax`: it reports a period refund's tax and confirms nothing |
| anything else (`invoice.payment_succeeded` too: `invoice.paid` says it) | ignored |

The Stripe webhook endpoint must be sent every event in this table.

The event id is Stripe's `event.id`; `occurredAt` is from `event.created`. A paid checkout can be
reported by both `completed` and `async_payment_succeeded` under different event ids; the host
matches on `checkoutRef`.

## The session

```ts
interface PaymentsSession {
  provider(): Promise<"stripe" | "fake">;
  createCheckout(input: PaymentsCheckoutInput): Promise<PaymentsCheckout>; // observation, no approval
  getPayment(ref: string): Promise<PaymentsPayment>;                       // observation
  refund(input: PaymentsRefundInput): Promise<PaymentsRefundReceipt>;      // action payments.refund
  subscribe(hook: PaymentsEventHook): Promise<void>;                       // bindHook
}
```

`createCheckout` validates its input (order id `[A-Za-z0-9_-]{1,64}`, a positive integer amount in
minor units, a three-letter currency, a 1 to 200 character description, an https return URL or
http on localhost/127.0.0.1, an optional customer email, a 1 to 200 character idempotency key),
records an observation (the order and amount, never the email) and opens the provider's page. It
needs no approval because it moves no money. The same idempotency key opens no second checkout.

### Tax at checkout (ADR 0479)
An optional `tax: { behavior: "inclusive", lines: [{ ref, name, amount, taxCode, place? }] }`
asks the provider to calculate tax inside the amount. The lines must sum to the amount; codes are
`txcd_` and eight digits; `place` is an in-person event's address (`country`, two upper-case
letters, and optionally `region`, `postcode`, `city`, `line1`). Without `tax` the input, and what
Stripe is sent, are exactly as before.

- **Stripe:** `automatic_tax[enabled]=true`, `billing_address_collection=required`, one line item
  per tax line (`tax_behavior=inclusive`, `product_data[tax_details][tax_code]`,
  `product_data[metadata][cos_line]`), and for a place
  `product_data[tax_details][performance_location]`: a tax location of type `performance`, made
  once per address with `POST /v1/tax/locations` and kept in the facet's storage. These calls
  carry `Stripe-Version: 2026-09-30.endive`. A paid taxed session's event carries
  `tax: { amount: total_details.amount_tax, country: customer_details.address.country, lines }`,
  the lines read from the session's line items (`amount_tax` by `cos_line`) before the event is
  stored; when they cannot be read, or the session has no `amount_tax`, the webhook is answered
  500 and Stripe sends it again. Stripe's Refund has no tax field: refund events carry none.
- **Fake:** the page asks for a billing country (a POST without `country` is answered 400), and
  the provider taxes each line inside its amount at `FAKE_TAX_REGISTRATIONS` (AU 10%, NZ 15%, GB
  20%; elsewhere 0), where the line's place is when it has one, else where the buyer is. Its
  refund events carry no tax, as Stripe's do not.

`getPayment(ref)` records an observation and returns `{ provider, ref, status: "open" | "paid" |
"expired", orderId, amount, currency, paymentRef }`.

`subscribe(hook)` asks the host to bind a hook (`Receive payment events (<provider>)`). Once a human
approves and the host calls `controller.enable(initiator, target)`, the provider's `PaymentsEvents`
DO stores the initiator; `controller.disable()` forgets it and cancels pending deliveries.

### Subscriptions (stage 32a, ADRs 0485 and 0486)

The provider runs the schedule; nothing here charges a card on its own.

| Method | What it does |
| --- | --- |
| `createSubscriptionCheckout(input)` | An observation, then the provider's page in subscription mode: the period's price (tax-inclusive, with the plan's tax code and automatic tax when `tax` is given), a trial of `trialDays` or free until `trialEnd` (at least 48 hours ahead), the card always taken, the host's id as `metadata.cos_subscription`. |
| `getSubscription(ref)` | An observation, then a read now. |
| `cancelSubscription({ when })` | Submits `payments.subscription.cancel` (never auto-approvable). Applied: Stripe `cancel_at_period_end=true`, or `DELETE` for `now`. |
| `resumeSubscription(input)` | Submits `payments.subscription.resume`. Applied: `cancel_at_period_end=false`. |
| `openPortal({ customerRef, returnUrl })` | Only for the host's own call (the queue answers `isHostOrders()`; Code Mode, extensions, the assistant and MCP are refused). An observation, then a customer portal session, on a configuration made once and kept in the facet (card, billing details, invoices; no cancel, update or pause). |
| `refund({ …, invoiceRef })` | As a refund, and once sent the invoice is credited with a credit note linked to it, so its tax is known. |

Every subscription call to Stripe sends `Stripe-Version: 2026-11-18.endive` (`STRIPE_BILLING_VERSION`).
A subscription webhook is verified, then the subscription (and invoice, `expand[]=payments`) is
read now with that version and delivered as the event: the payload's own shape depends on the
endpoint's version, and Stripe does not deliver events in order. A failed read answers 500, so
Stripe sends it again. A subscription the read shows this host did not start (no
`metadata.cos_subscription`), or one in a shape it cannot read (a tiered, metered or decimal price),
is answered 200 and counted in the events' stats (`ignored.foreign`, `ignored.unreadable`), never
500: a retry would never succeed, and Stripe disables an endpoint that keeps failing. A period
refund whose credit note failed stays pending; applying it again sends only the credit note. A
reused customer Stripe no longer knows (`resource_missing`) is replaced by a new one from the
payer's address. The fake provider's ledger keeps subscriptions too; tests move its schedule
on with `advanceFakeSubscription(env, ref, step)` (`renew`, `fail`, `retry_fail`, `recover`,
`action_required`, `give_up`, `trial_will_end`), which has no route. `GET {base}/fake/portal/:ref`
is an inert stand-in for the portal.

## Events

```ts
type PaymentsEvent =
  | { kind: "payment"; provider; eventId; orderId; checkoutRef; amount; currency; paymentRef; occurredAt }
  | { kind: "refund"; provider; eventId; orderId | null; refundId | null; refundRef; paymentRef; amount; currency; occurredAt; tax?; creditNote? }
  | { kind: "subscription"; provider; eventId; trigger; subscription; invoice?; occurredAt };
```

Currencies are upper case, amounts minor units, `occurredAt` ISO 8601. For each new event the DO
calls `initiator.startHook()`, records an observation `Payment event <kind>` (amounts, ids and
currency only: never an email or card data), then calls `callback.receiveEvent(event)`. Delivery
runs from the DO's alarm through the kit's `HookDeliveryQueue`: a failing hook is retried with
backoff and dropped after 8 attempts with a warning that quotes nothing. Each provider keeps its
last 100 events and the event ids of the last 30 days (at most 10,000) for replay dedupe.

## The refund action

`refund(input)` validates `{ orderId, paymentRef, amount, currency, reason (1 to 500 characters),
refundId (1 to 64) }` and submits an action of kind `{ tag: "payments.refund", label: "Refund a
payment" }`. It is never auto-approvable (`getAutoApprovableActions()` returns `[]`), and nothing is
sent until the host applies it. It returns `{ status: "pending" | "sent", id }`.

The approver sees a title like `Refund 25.00 AUD on order ord_x` (minor units formatted with the
currency's digits) and the fields Provider, Order, Payment, Amount (`25.00 AUD (2500 minor
units)`), Reason and Refund id, shown literally (`descriptionIsComplete: true`,
`implementsRevert: false`).

- **apply** calls the provider's `refund` once (`claimBeforeApply`, so a crash mid-call is never
  replayed). A refusal before anything was refunded (a Stripe 4xx, the fake refusing an over-refund)
  fails it terminally (`ActionApplyError`). A 5xx or network failure is an unknown outcome
  (`ActionOutcomeUnknownError`): it is never retried blindly, and the approver should check the
  provider before submitting it again. A Stripe 429 is a plain error, left pending for a retry,
  which the idempotency key makes safe.
- **reject** sends nothing.
- **revert** throws: a refund cannot be taken back.

## Stripe

Plain `fetch` against `STRIPE_API_BASE` with `Authorization: Bearer <STRIPE_SECRET_KEY>`,
form-encoded bodies, an `Idempotency-Key` header, and `Stripe-Account: <STRIPE_ACCOUNT>` when that
var is set (a connected account, so the money goes to the org's own account). **No Stripe-Version is
pinned**: the account's default API version applies, so check the fields above against it when
upgrading the account's version.

- Checkout: `POST /v1/checkout/sessions` with `mode=payment`, one line item
  (`price_data[currency]` lower case, `unit_amount`, `product_data[name]` the description,
  `quantity=1`), `success_url` and `cancel_url` both the return URL, `client_reference_id`,
  `metadata[order_id]`, `payment_intent_data[metadata][order_id]`, `customer_email` when given, and
  `expires_at` 31 minutes out (Stripe's minimum is 30; the extra minute absorbs clock skew). The
  idempotency key is the caller's.
- Read: `GET /v1/checkout/sessions/:ref`.
- Refund: `POST /v1/refunds` with `payment_intent`, `amount`, `reason=requested_by_customer`,
  `metadata[order_id]`, `metadata[cos_refund_id]` and `metadata[reason]` (cut to 500 characters);
  the idempotency key is the refund id.

Nothing is logged: not request bodies, secrets, emails or responses. Errors carry Stripe's error
type and code, never its message.

## The fake provider

On only when `PAYMENTS_FAKE_PROVIDER` is `"true"`, and off localhost only with its own
`FAKE_WEBHOOK_SECRET`. For development, tests and staging (an environment marked `live: false`).

- `createCheckout` records a checkout in `FakePaymentsLedger` (ref `fcs_…`, expiring in 30
  minutes) and returns `url = {base}/fake/pay/<ref>`.
- `GET {base}/fake/pay/:ref` is a self-contained page ("Fake payment page", no external assets, no
  card fields) showing the description and amount, with a **Pay** form (`outcome=pay`) and a
  **Cancel** form (`outcome=cancel`) posting back to the same URL.
- `POST … outcome=pay` marks the checkout paid once (a second pay is a no-op), mints a payment ref
  `fpi_…`, delivers a signed `payment.succeeded` event to `/in/fake` by calling the route's own
  handler in process (so the signature check runs), and answers `303` to the return URL. An
  optional `amount` field overrides the amount the event reports, for mismatch tests.
  `outcome=cancel` answers `303` to the return URL without paying.
- `refund` records the refund (`fre_…`), refusing one that would take the refunds on that payment
  past what was paid, an unknown payment or another currency; once the call has returned, it
  confirms by a signed `refund.succeeded` delivery to `/in/fake`.
- Fake deliveries are `{ id, type: "payment.succeeded" | "refund.succeeded", created, data }`,
  where `data` holds the event's fields.

## Environment

| Variable | Meaning |
| --- | --- |
| `BASE_URL` | The public base, e.g. `https://crm.example.com/gatekeeper/payments`. Builds the fake page URLs and the route prefix. Empty means `http://localhost:5173/gatekeeper/payments`. |
| `STRIPE_API_BASE` | The Stripe API base. Empty means `https://api.stripe.com`. |
| `STRIPE_ACCOUNT` | A Stripe connected account id, sent as `Stripe-Account`. Empty means the key's own account. |
| `PAYMENTS_FAKE_PROVIDER` | `"true"` turns the fake provider on, but off localhost only when the `FAKE_WEBHOOK_SECRET` secret is set (the default secret is public, ADR 0485). Default `"false"`. |

| Secret (optional, `wrangler secret put`) | Meaning |
| --- | --- |
| `STRIPE_SECRET_KEY` | The Stripe secret (or restricted) key. Without it the Stripe account is refused. |
| `STRIPE_WEBHOOK_SECRET` | The `whsec_…` secret of the Stripe webhook endpoint posting to `{base}/in/stripe`. Without it every Stripe delivery is `401`. |
| `FAKE_WEBHOOK_SECRET` | The fake provider's signing secret. Not set by a person: the installer and `cos deploy` generate it, once, for a deployment that turns the fake on (only an environment marked `live: false` may), never print it and keep it on later deploys (issue #217). Unset means `fake-payments-dev-secret`, accepted only when `BASE_URL` is `http://localhost` or `http://127.0.0.1` (the CRM's dev server and e2e). |

The secrets are declared for the release manifest in [`deploy-inputs.json`](deploy-inputs.json)
and typed in [`src/env.d.ts`](src/env.d.ts). Bindings: `PAYMENTS_EVENTS` (`PaymentsEvents`),
`FAKE_PAYMENTS` (`FakePaymentsLedger`). Compatibility flag `allow_irrevocable_stub_storage` (the
stored initiator).

## Development

```sh
pnpm --filter @composable-os/gatekeeper-payments typecheck   # wrangler types --check + tsc
pnpm --filter @composable-os/gatekeeper-payments test        # workerd, @cloudflare/vitest-plugin
pnpm --filter @composable-os/gatekeeper-payments build       # wrangler deploy --dry-run
```

The tests run `__tests__/worker.ts`, which re-exports the Worker and adds `TestHost` (a Durable
Object that plays the integration host through `ctx.facets`) and `TestInitiator`. The test config
turns the fake provider on and sets test-only Stripe secrets; the Stripe provider's HTTP calls are
tested with an injected `fetch`.

No capnweb-validate decorators: the CRM's Vite dev server runs this Worker as an auxiliary worker
and cannot transform them, so every RPC input is checked by hand (`src/validate.ts`).
