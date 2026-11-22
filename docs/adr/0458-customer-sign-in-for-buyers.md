# ADR 0458: Customer sign-in for buyers, and the fake payment page's way back

Status: accepted, 2026-11-23 (`feat/customer-sign-in-for-buyers`; the owner's decision at the
interview of 2026-11-23). Builds on ADRs [0402](0402-staff-and-customers.md),
[0419](0419-native-sessions-and-customer-sign-in.md),
[0427](0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md),
[0428](0428-buying-without-an-account.md) and
[0429](0429-payments-gatekeeper-verified-events-and-refunds.md). No migration.

## Context
Customer sign-up was `invite_only` (the default) or `open`. A guest who bought a ticket, and later
asked for a sign-in code to see it, was told a code was on its way and got none: they had not been
invited. The owner decided that each business chooses who may sign in as a customer: invite only,
anyone who has bought, or anyone. The first client's choice is its members plus anyone who has
bought.

Separately, on the payments gatekeeper's fake provider page, Pay took the payment but Chrome blocked
the redirect back to the company's site: the page's `form-action 'self'` holds a form's redirects
too, and the return address is on another origin.

## Decision

### The `buyers` sign-up mode
- **`customer.settings` `signup` is `invite_only` (default), `buyers` or `open`.** With `buyers`, a
  code goes to an address staff invited, one with an account (while active), or the buyer's address
  of an order **a verified payment was applied to** (`core_order.paid > 0`, `hasBought`).
- **Which orders count, and why:** paid and part-paid; and refunded or cancelled after a payment
  (the buyer paid with that address, and may need to see the refund or the cancelled order). Never
  an order only started (`pending`), `expired`, or cancelled with nothing paid: starting a checkout
  costs nothing, so counting it would let anyone make any address able to sign in. A paid order
  proves only that someone paid with that address in the order; the code still goes to the
  address, so only its owner signs in.
- **The answer stays uniform:** the code routes (browser and native) answer every address the same,
  and send nothing when the rule says no, as for the other modes. An erased person's address never
  gets a code, whatever the mode.
- **Signing in is an invited customer's sign-in:** the account is made at the first sign-in (the
  same Better Auth hook, which checks the same rule a second time) and linked to the buyer's Person
  by `linkCustomer`. The order already belongs to that Person (ADR 0428), so its tickets are the
  customer's at once. An order whose address matched several People belongs to no one, and the
  account waits for staff to merge them (`needs_attention`), exactly as for an invited customer.
- **A human admin's to change:** `customer.settings.update` (`settings:manage`, `actors:
  ["human"]`, not on MCP, audited, as before), from Settings → Users, "Who can sign in as a
  customer", in plain words for the three modes.
- **Not a `product.ts` default.** ADR 0452's per-environment settings are a gatekeeper Worker's
  vars and bindings, not identity policy in the database. A `product.ts` default applied at the
  first install would be a policy a coding agent can write (agents edit `product.ts`, and the
  skills tell them to), and one applied on a deploy would loosen sign-in on an existing host. So
  `cos deploy` sets no sign-up mode; the owner picks it once on Settings → Users. The default
  stays `invite_only` for every product.

### The fake payment page
- **`form-action` allows the checkout's own return origin**, read from the checkout the host
  opened (its `returnUrl`, which `order.checkout` checks against the deployment's listed sites,
  ADR 0429), not from the request: `form-action 'self' <that origin>`. The page also gains
  `frame-ancestors 'none'`, `X-Frame-Options: DENY` and `base-uri 'none'`.
- **A post from another site is refused:** a named Origin that is not the page's, Fetch metadata
  `cross-site` or `same-site`, or `Origin: null` without `Sec-Fetch-Site: same-origin`. A request
  with neither (a script or a test) is let through: the page is a development stand-in, and every
  browser sends one or the other on a form POST.
- **The amount paid is the checkout's**, as the host priced it. The form's `amount` (a test
  convenience) is gone.
- **No route reads the fake ledger** (`/fake/state` is removed): on a staging host on the public
  internet it showed every checkout, with its return address (a guest's order link carries the
  order's token) and amount. Tests read it through the ledger's binding.
- **Unchanged:** the Stripe path. Stripe's hosted page sends the buyer back itself; nothing of
  ours is between.

## Why
- The buyer's own payment is the evidence that the address belongs to a customer of the business,
  and it cannot be made without paying; the emailed code is the evidence that this person controls
  it.
- Allowing exactly the recorded return origin is the least a browser needs to follow the redirect.

## Proof
`packages/core/test/customer-buyers.test.ts`, `apps/app/test/buyer-sign-in.test.ts` (the real
customer sign-in routes, browser and native), `apps/runner/test/ticketing.test.ts` (a real guest
purchase on the fake provider, then the buyer's tickets as a signed-in customer),
`packages/gatekeeper-payments/__tests__/payments.test.ts`, and the e2e
`apps/app/e2e/buyer-sign-in.spec.ts` (Chromium pays on the fake page, lands back on the company's
site on another origin, then the buyer signs in and reads two tickets; an address that only
started a checkout gets the same answer and no code). Each check removed, its test failed:

| Check removed | Test that fails |
| --- | --- |
| `paid > 0` (any order counts) | never for a checkout only started, expired, or cancelled unpaid |
| Buyers only in the `buyers` mode | `invite_only` gives a buyer nothing |
| The `buyers` mode sending to buyers | paid, part-paid and refunded-after-payment buyers get a code |
| The erased-address check | never an erased address |
| `actors: ["human"]` on the setting | refused to MCP, the assistant and automations |
| The return origin in `form-action` | the page's CSP test; the e2e lands back on the site |
| The cross-site check | a post from another site is refused |
| `null` refused without same-origin metadata | the same test |
| The amount from the checkout | an amount in the form is ignored |

## Consequences
- A business that sells to the public turns `buyers` on once, on Settings → Users.
- Left as they are on the fake provider (development and staging only, `PAYMENTS_FAKE_PROVIDER`):
  the page has no per-form token (the cross-site check is its CSRF defence, and a non-browser
  client can still post); the fake webhook secret falls back to a public default when unset; and
  the fake integration vendor's helper routes (`/gatekeeper/fake/*`, `INTEGRATIONS_FAKE_PROVIDER`)
  have no authentication. A staging host on the public internet should sit behind Access for staff
  paths (`docs/deploying.md`).

## Note (2026-11-22, issue #221)
A buyer is also the live Person whose order it is now: `hasBought` reads orders placed with the
address or owned by the Person who has that address, so after a person merge (which moves
orders, ADR 0487) the survivor can sign in under any of their addresses in `buyers` mode.
