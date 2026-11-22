# Stage 32: Allowances, recurring billing and Memberships

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Behaviours, Orders, Packs and blocks), [`CONTEXT.md`](../../CONTEXT.md), ADRs
[0404](../adr/0404-behaviours-are-the-vocabulary.md),
[0427](../adr/0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md) to
[0435](../adr/0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md),
[0458](../adr/0458-customer-sign-in-for-buyers.md),
[0477](../adr/0477-the-access-scope.md) to [0480](../adr/0480-an-ai-asks-to-publish-a-person-approves.md);
stages [25](25-states-orders-payments.md), [26](26-capacity-and-holds.md),
[27](27-ticketing-and-ghetto.md), [41](41-programs.md) and [42](42-courses.md) (its "Decided for
stage 32" section); `packages/core/src/orders/`, `packages/core/src/capacity/`,
`packages/core/src/visibility/access.ts`, `packages/gatekeeper-payments/src/`, `packs/courses`.

Status: **32a built** (steps 1 to 4; never run on real Stripe: the test-mode runbook waits for
the owner); **32a spec agreed** (interview 2026-11-22: questions 1 to 7, each with its recommended
answer); **32b agreed** (questions 8 to 16 answered the same day; it waits for
stage 31). The decisions already made at stage
42's interview are listed below and are not asked again. Where this spec guesses, it says
**(guess)**.

## Goal

A company can sell something that is paid for every month: a subscription to its online courses,
or a gym membership. The provider keeps the card and charges it each period; the host knows from
verified events whether a person is paid up, and what that gives them. A membership or a pass can
also grant a number of uses (ten visits, three classes a week, a credit of three courses), which
something else spends; stage 31's bookings will be the main spender. Members see and manage their
own plan on the web, and see it in the app. Staff see who is paying, who is failing, and what each
person has left.

The first client needs it in two steps: first **the course subscription**, so its online program
can finish moving off the hosted course platform; then **memberships and passes**, which, with
stages 31 (bookings) and 33 (leaving its current booking system), replace that system.

## Decided at the interview (2026-11-22)

Questions 1 to 7 (32a) were settled, each with the recommended answer; the questions are kept at the
end with their decision. 32b's questions, 8 to 16, were
answered the same day. Question 8 was answered with every option, including limits by time of
day: the spec holds that a time-of-day limit needs the booking's time, so stage 31 carries that
part. 32b waits for stage 31.

| Question | Decision |
| --- | --- |
| 1. Split the stage | (b): 32a (the subscription, the course plan, the course subscribers' move) first; 32b (allowances, Memberships) later, with stage 31 |
| 2. Who runs the schedule | (a): the provider keeps the card, charges, retries, emails and ends the subscription; the host mirrors verified events |
| 3. Every paid period an order | (a): a paid order per period, created by the host from the verified invoice event |
| 4. While a renewal is failing | (a): the member keeps everything while the provider retries; access stops when it gives up (the provider's setting for exhausted retries is "cancel") |
| 5. Members' billing | (a): the provider's portal for the card and past invoices only; cancel and resume are host operations |
| 6. Who emails about failed payments | (a): the provider, from its own settings; the host tells staff |
| 7. Continuation and the trial | (a): the continuation replaces the 7-day trial: free until the paid-up date, then charged |
| 8. What the gym sells (32b) | (c): everything listed, including limits by class type and by time of day (the time-of-day limit needs stage 31's booking time) |
| 9. Carry-over (32b) | (a): no carry-over: each period starts fresh |
| 10. Pauses (32b) | (b): paused by staff, for a set time |
| 11. Minimum term (32b) | (a): no minimum term: cancel any time, effective at the period's end |
| 12. Plan changes (32b) | (c): upgrades at once, prorated; downgrades at the next period |
| 13. One person pays for another (32b) | (b): a payer and a holder (a parent pays for a child), each holder with their own allowance; no shared pool |
| 14. Moving members' billing (32b) | (a), (b) the fallback: ask the current provider about transferring card data to Stripe now; members subscribing again (32a's continuation offers) is the fallback |
| 15. Late cancel or no-show (32b) | (a): no money: a late cancel or a no-show keeps the use |
| 16. Pick any N courses (32b) | (b): no pick-any-N course credit passes; fixed bundles only |

## Decided already (stage 42 interview, 2026-11-23)

| Question | Decision |
| --- | --- |
| What a subscription to courses covers | Every published course, including ones added later |
| The free trial | A card is taken at the start; the first charge is when the trial ends unless cancelled; one trial per Person |
| Today's course subscribers on the hosted platform | They stay there until this stage ships. Then each subscribes again on the new site, free until the date they have already paid up to, and the old subscription ends at its period end. The hosted school takes no new subscribers once the new site opens |
| Tax | Calculated by the provider at checkout, prices tax-inclusive (ADR 0479) |
| Where people buy | On the web, never in the app (stage 42; the block lint's `noPurchase`, ADR 0478) |

## What exists today (from the code)

- **Orders** (stage 25, ADRs 0427 to 0429; `packages/core/src/orders/`). `core_order` and its
  lines, priced by the host in one currency, in minor units; the state machine `pending` →
  `part_paid` → `paid` → `refunded`, `cancelled`, `expired`, every paid move a `host` move made
  only by a verified payment (`payments.ts`, `applyVerifiedPayment`); refunds of one payment,
  through approval by a person with `orders:refund` (`refunds.ts`). Each payment is a row of
  `core_order_payment`. Deposits: a part now and the balance by a date, each part its own
  checkout. **No card is stored and nothing is charged on a schedule.**
- **The payments gatekeeper** (`packages/gatekeeper-payments/src/`): `PaymentProvider` with
  `createCheckout`, `getPayment`, `refund`, `verifyWebhook`; Stripe and a fake provider; Stripe
  Checkout in `mode=payment` only (`stripe.ts`); events of kind `payment` and refunds
  (`types.d.ts`, `PaymentsEvent`); the org's own Stripe account (`STRIPE_ACCOUNT`).
- **Tax at checkout** (ADR 0479, `orders/tax.ts`, migration 0516): two switches (a human admin's
  setting and the object's `sellable.tax.code`); each payment split over its lines; the
  provider's tax figure stored per payment, line and order; a performance location for in-person
  events; a refund's tax recorded only when the provider says it (Stripe's Refund has no tax
  field).
- **`sellable` and grants** (ADR 0435, `orders/sellable.ts`, `orders/grants.ts`): one record per
  unit granted in the paid batch, voided on a full refund or a cancel after a deposit.
- **`capacity`** (stage 26, `packages/core/src/capacity/`): places, held and confirmed claims made
  in the owner's own batch, refused by the database past the limit. The pattern an allowance
  follows.
- **The access scope** (ADR 0477, `visibility/access.ts`): `access.sources` on an object, one
  question (`holdsAccess`), record sources, and `registerAccessSource(kind, { holders, problems
  })` for kinds the host provides: "Stage 32 adds `subscription` this way", with no change to the
  seam, the holders' flag or `media.play` (criterion 6 of stage 42 proved it with a fixture kind).
- **Courses** (ADR 0478, `packs/courses`): courses and fixed bundles, enrolments as grants,
  `access.check` for a tool, the `noPurchase` block lint. No plan object.
- **Customers** (stage 22; ADR 0458): sign-up `invite_only`, `buyers` (anyone a verified payment
  was applied to) or `open`, a human admin's setting.
- **Behaviours designed, not built:** `recurring` (stage 31) and `allowance` (this stage; ADR 0404,
  CONTEXT.md "Allowance": "a number of uses, or unlimited uses over a period. A booking spends one").
- **Words already taken:** "entitlement" (a hosted plan's limits, ADR 0211), "grant" (a record a
  paid line creates; also an agent's grant), "plan" (a hosted plan, ADR 0211). This spec says
  **subscription**, **membership plan** (or "plan" inside the pack's own names), **pass** and
  **allowance**; CONTEXT.md is amended so "plan" alone is not ambiguous.

## How the stage is split

**32a, the subscription** (small; the course subscription ships on it). Recurring billing run by
the provider, the subscription base record, an order per paid period, tax on each period, the
`subscription` access source, a course plan in the Courses pack, members' self-service for
billing, and the move of today's course subscribers.

**32b, allowances and Memberships** (larger; ships with stage 31). The `allowance` behaviour,
the Memberships pack (membership plans, passes, what they allow), pauses, plan changes, shared
memberships if any, the staff side for a gym, and the import door stage 33 uses for members.

**What 32a needs from 32b: nothing.** What 32b needs from 32a: the subscription record, its
states and events, the gatekeeper's subscription calls, and the order per period. 32a is built so
32b only adds to it: a subscription names its plan record by object and id, so any pack's
recurring sellable object can be a plan; and a subscription may grant a record of the plan's
pack (`recurring.grants`), which is where 32b's allowances live. Courses does not use that grant:
its access reads the subscription itself.

## Scope, 32a: the subscription

### Recurring billing: the provider runs the schedule (decided, question 2)
- **The provider keeps the card, charges each period, retries a failed charge, and ends the
  subscription when told or when its retries run out.** The platform stores no card and schedules
  no charge, as stage 25 decided for everything else. The host learns what happened only from
  verified events.

| | The provider runs it (decided) | The host schedules charges |
| --- | --- | --- |
| A failed payment | The provider retries on its own schedule (Smart Retries) and emails the customer; the host mirrors `past_due` | The host's cron retries; we write the schedule, the emails and the give-up rule |
| A card update | The provider's own page (customer portal); 3D Secure on a renewal goes to its hosted invoice page | We store a payment method (still at the provider), run a setup flow, and handle 3D Secure off-session ourselves |
| Proration, plan changes | The provider's proration, or a change at the period's end by its schedules | Ours to compute, in the host's rules |
| Pauses | The provider's pause of collection | A flag on our schedule |
| Cancellation | At period end or now, by one call | Stop scheduling |
| Refunds | Of one period's invoice payment, as any refund | The same |
| Tax each period | The provider's tax on each invoice, inclusive | A checkout's tax per charge (ADR 0479) |
| Cost | The provider's billing fee: 0.7% of billing volume, pay as you go, on the page served when read (**check the company's own region at build**) | No billing fee; our code and its failure modes |

- **Stripe Checkout in subscription mode** opens the subscription on the provider's own page, as
  `order.checkout` does for one payment: the plan's price per period from the record (inline price
  data, `recurring` interval), tax-inclusive, `automatic_tax` when the tax setting and the plan's
  code say so, the billing address required when taxed, and the trial with the card taken first
  (`subscription_data.trial_period_days`; Checkout collects a payment method by default, and
  `payment_method_collection` stays `always`). Stripe now calls this kind of trial "legacy" and
  recommends "trial offers" for new builds, but Checkout supports trial offers only in a private
  preview, so the build uses trial days and moves when Checkout supports offers (**check at
  build**). If the card is missing at the trial's end, the provider cancels
  (`trial_settings.end_behavior.missing_payment_method=cancel`).
- **The provider's billing mode** is "flexible" for new subscriptions, because the newer `paused`
  status and pause-on-failure need it (32b).

### The subscription record
- **`core_subscription`, a base record**, beside Order: two People, the payer (the provider's
  customer) and the holder (who what it grants is for), the holder the payer in 32a (question 13
  was answered (b): 32b lets them differ, with no breaking migration; access and the one-trial
  rule follow the holder, billing, the portal, cancel and resume the payer), the plan (object and id) and the plan's title and price
  as they were at the start, the provider's references (customer, subscription), the state, the
  trial's end, the current period's start and end, whether it ends at the period's end, when it
  ended and why. It declares `customer`, so a customer reads their own; staff read all. It is in
  the registry but not the generic object list, as Order is (ADR 0427).
- **States, all `host` moves made only from a verified provider event.** The host's states mirror
  the provider's: `incomplete` (the first payment must succeed within 23 hours) → `expired` (the
  provider's `incomplete_expired`, final) or → `trialing` → `active` ↔ `past_due` → `ended` (the
  provider's `canceled`, final); `active` ↔ `paused` (32b); `past_due` → `unpaid` only if the
  company's provider settings choose it (proposed: they choose cancel). "Ending at period end" is
  a flag on `trialing` or `active`, not a state. A person who comes back starts a new subscription.
- **Events read:** `checkout.session.completed` (the subscription exists),
  `customer.subscription.created`, `.updated`, `.deleted`, `.paused`, `.resumed`,
  `.trial_will_end` (three days before), `invoice.paid` (a period paid: the provider says to give
  access on it while the subscription is `active`), `invoice.payment_failed` (with its attempt
  count), `invoice.payment_action_required` (the customer must authenticate),
  `invoice.finalization_failed` (for example tax with no location: nothing can be collected, so
  staff are told) and `charge.refunded`. Each is verified by the gatekeeper and applied by the
  host as payments are today (`core_payment_event`).
- **A move is made from a current read** (ADR 0437) and a repeated event changes nothing (the
  provider's event id, as `core_payment_event` does today).
- **One trial per Person per plan object** (decided): the host refuses a trial to a Person who has
  had one on any record of that plan object (**guess**: per object, so a second course plan later
  gives no second trial), and the provider's page then asks for the first payment at once.

### An order per paid period (decided, question 3)
- When the provider says a period's invoice is paid, the host writes a `core_order` born `paid`
  (a new `host` path: created and paid in one batch, from the verified event), one line for the
  plan, with the period's dates, the provider's tax figures (ADR 0479's columns) and the
  provider's invoice and payment references. The trial's start is no order; a period that costs
  nothing (a free continuation, below) is no order.
- So revenue, `rec_order`, tax reports, the confirmation email, refunds and the dashboards stay
  one path. A refund of a period is a refund of that order's payment, through approval, as built;
  it does not end the subscription (ending it is its own action).
- **Refunding a period through a credit note.** For an invoice's payment the provider reduces the
  tax it reported automatically, and a credit note with a refund amount splits the refund between
  tax and net. So a period's refund is made as a credit note with a refund, and the order records
  the tax it gave back, which ADR 0479 could not do for a Checkout payment (**guess**: the credit
  note's tax figure reaches the host on its event; check at build).

### Access for courses
- The host registers the `subscription` access source kind (`registerAccessSource`): a customer
  holds a record when they have a subscription in `trialing`, `active`, or `past_due` (question
  4), or one ending at its period's end with time left, on a plan whose declaration covers it.
  `covers: "all"` (every live record of the object; decided for courses) is the only cover in
  32a; a list is left for later. The host does not use the provider's own "entitlements" feature:
  access is the seam's rule, read from the host's own record.
- The Courses pack gains **`courses.plan`** (title, description, price per month, trial days,
  tax code `txcd_20060158` as its courses, public), `sellable` with `recurring: { interval,
  trialDays }`, and adds `{ kind: "subscription", options: { plans: "courses.plan", covers:
  "all" } }` to `courses.course`'s `access.sources`. `myCourses` says "through your subscription".
  Nothing else in the seam, the holders' flag or `media.play` changes (ADR 0477).

### Members' self-service (question 5)
- **The provider's portal** is opened by a session for one customer (`billing_portal/sessions`,
  with a return address), with a configuration the host chooses (only card, billing details and
  invoices on), so cancelling and plan changes go through the host's operations; it cannot be put
  in a frame, and a session expires within the hour. A subscription with a schedule attached (a
  fixed term, question 11) cannot be changed or cancelled in the portal at all.
- **Web:** `subscription.start { planId, email? }` (customer, public) opens the provider's page;
  `my.subscriptions` (customer) reads their own; `subscription.cancel { id }` (customer, their
  own) asks the provider to end it at the period's end, and `subscription.resume { id }` undoes
  that before it happens; `subscription.portal { returnUrl }` (customer) opens the provider's
  customer portal for the card and past invoices. Each is the host's own call to the gatekeeper
  (`callAsHost`), as a checkout is.
- **App:** the subscription's state, next charge date and what it gives, read only. No start,
  cancel or portal link in a native block (`noPurchase`); **(guess)**: cancelling is not a
  purchase, but keeping every billing action on the web is the simpler rule for the stores.
- **Staff:** cancel now or at the period's end, with a reason (`subscription.cancel { id, now }`,
  a new permission `subscriptions:manage`, grantable as `orders:refund` is; an AI may propose, a
  person approves, as for refunds); a refund of a period as above.

### Failed payments (question 4 and 6)
- Retries are the provider's, set in the company's own provider settings (listed in the runbook as
  theirs). Smart Retries is the default for new accounts: up to 8 retries within 2 weeks, the
  window settable from a week to two months; hard declines (a lost or stolen card) and a missing
  card are not retried. After the last retry the provider cancels, marks unpaid, leaves past due,
  or pauses, as the company set. The host mirrors `past_due` and tells staff once; a daily list of
  failing subscriptions is on the staff side.
- **3D Secure on a renewal:** the provider's emailed link to its hosted page, where the customer
  confirms the payment (a provider setting); the host reads `invoice.payment_action_required` and
  shows "confirm your payment" in the subscription block with that link.
- **What access does while a payment is failing** is question 4; **what happens when retries run
  out** is the provider's setting the company chooses (cancel the subscription is recommended,
  so the host sees `ended`).
- **Who emails the customer** about a failed payment or an expiring card is question 6.

### Tax on each period
- The provider's tax on every invoice, from the plan's tax code, inclusive (ADR 0479's rule that
  the amount is the price holds); the host stores the provider's figures on each period's order.
  **(guess)**: a gym membership's code (the provider's list has "Fitness Centers - Dues and
  Membership Fees", `txcd_50021001`) needs the gym's address as its place, as event admission
  does; checked at build.
- **Turning tax on later does not reach subscriptions already running**: the provider says they
  must be updated to collect it. The host updates every live subscription when a human admin turns
  tax on, and says how many it changed (**guess** at the mechanism; the provider's page on it was
  seen only as a search result).
- An invoice the provider cannot finalize for want of a tax location (`invoice.finalization_failed`)
  cannot be collected; staff are told at once.

### Today's course subscribers: the continuation
Decided: each subscribes again, free until the date they have paid up to; the old one ends at its
period's end.
- Staff import a list (email, paid-up date, the old platform's reference) as **continuation
  offers** (`subscription.offers.import`, a person only, `record.import`'s rules: keys, a dry run,
  conflicts kept). An offer is a Person, a plan and a free-until date.
- The person signs in (they are imported people; sign-up mode `buyers` or an invite lets them) and
  subscribes from a page that shows the offer; the host opens the provider's page with the trial
  ending at the offer's date and the card taken now. **(guess, question 7)**: the continuation
  replaces the 7-day trial rather than adding to it.
- The old subscription is ended on the old platform by the company (it cannot be reached from
  here). A report lists who has taken their offer, so the company ends exactly those, at their
  period's end, and chases the rest before their paid-up date.
- Nothing charges a card the person did not give to the company's own account.

## Scope, 32b: allowances and Memberships

### The `allowance` behaviour
An object declares that its records **hold an allowance**, and another object declares that its
records **spend** one. The host keeps the count and refuses a spend past it in the spender's own
batch, as `capacity` refuses a claim past its places (stage 26).

- **A holder** (a pass, a membership's granted record) declares: how many uses (`uses`, a number
  field; empty is unlimited), over what (`per: "total" | "week" | "month"`), what it may be spent
  on (`spendsOn: { object, when? }`: an object, and optionally a condition on the spender's
  record, such as a class type in a list the holder names), from when to when (`from`, `until`
  fields), and its states (only an active holder can be spent).
- **A spender** (stage 31's booking; a "pick a course" enrolment) declares `allowance: { holder:
  <field> }`: the relation on its record naming the holder it spends from, or `auto` (the host
  picks the holder that expires first among the person's live ones that match).
- **`core_allowance_use`**: the holder, the spender's record, the period it counts in, when it was
  spent and, if given back, when. A spend is written in the spender's create; a give-back in the
  spender's move to a state the spender declares as returning (a booking cancelled in time). A
  late cancel or a no-show keeps the use (stage 31's rules decide which moves return).
- **Counting:** a holder's uses in a period is the count of unreturned use rows in it; a CHECK and a
  trigger refuse one past `uses`, so the whole batch is not applied, for every actor. Weeks start
  on Monday in the deployment's time zone (**guess**; the holder's zone field if it has one).
- **Expiry and carry-over:** a holder past `until` gives nothing; unused uses do not carry over
  between periods (question 9).
- **Read:** a holder's record carries read-only `used` and `left` for the current period;
  `allowance.get` gives a customer their own and staff any; `rec_allowance_use` is queryable.
- **How it meets stage 31 without it existing:** the behaviour is proved with a fixture spender (a
  box-office-style test extension: a "visit" record that spends), and with Courses' "pick any
  three" if question 16 says build it (an enrolment that spends a credit). Stage 31 declares a
  booking a spender and its cancel moves as returning; nothing in 32b knows what a booking is.

### The Memberships pack (`packs/memberships`)
| Object | What | Behaviours |
| --- | --- | --- |
| `memberships.plan` | Title, description, price per period, interval, what it allows (unlimited, or N per week or month), which class types (a list, empty for all), trial days, a commitment (question 11), tax code, public | `publishable` with `public`; `sellable` with `recurring`, granting a `membership` |
| `memberships.membership` | Its Person, its plan, its subscription, what it allows as at the start, from, until, state (`active`, `paused`, `ended`, `void`) moved by the host with the subscription | `customer: person`; `allowance` holder |
| `memberships.passtype` | Title, number of uses, valid for N days, which class types, price, tax code, public | `publishable` with `public`; `sellable` (one-off), granting a `pass` |
| `memberships.pass` | Its Person, its pass type, its order, uses as bought, from, until (the purchase date plus the days), state (`active`, `used`, `expired`, `void`) | `customer: person`; `allowance` holder |

- A drop-in is a pass of one use (**guess**: no separate object).
- **A subscription's grant follows it:** the membership is granted when the subscription first
  becomes `trialing` or `active`, moved to `paused` and back with it, and to `ended` when it ends,
  as the host, in the event's batch (`recurring.grants`, the same declaration and checks as
  `sellable.grants`).
- **A full refund of a pass** voids it; uses already spent stay spent (the bookings happened).
  **(guess)**: refunding part of a pass is staff's choice of amount, with the pass voided or not.

### Plans and plan changes (question 12)
- A member changes plan on the web (`subscription.change { id, planId }`), which asks the provider
  to switch the price; when it takes effect and whether it is prorated is question 12. The
  membership's allowance follows the plan from the change.
- What the provider does: a change now prorates by default (`create_prorations`, invoiced at the
  next period, or now with `always_invoice`); "negative prorations aren't automatically
  refunded"; a change whose immediate charge fails still applies and leaves the subscription
  `past_due` unless it is made a pending update; a change at the period's end is a subscription
  schedule. The host uses pending updates, so a member never gets an upgrade they did not pay
  for.

### Pauses (question 10)
- If pauses are allowed, `subscription.pause { id, from, until }` uses the provider's `paused`
  status (flexible billing mode; no invoices while paused; `customer.subscription.paused` and
  `.resumed`), not `pause_collection`, which keeps the subscription `active` and so would keep
  access on. The host moves the subscription and the membership to `paused`, which spends nothing
  and gives no access, and back at the end. The provider refuses a pause while trialing, with a
  schedule attached, or when `unpaid`; the host refuses the same first. A future start or a set
  end uses the provider's pause schedules (**not read; check at build**).
- **Stripe's `pause_collection` is not a pause here** (recorded at 32a's review, 2026-11-22): it
  keeps the subscription `active`, so the host keeps giving access and spends uses. The host does
  not read it as paused; staff pause through the host's own pause (above), never by pausing
  collection in the provider's dashboard.

### Shared memberships (question 13)
- Proposed: a payer who is not the holder (a parent pays for a child): the subscription's payer
  and the membership's holder are two People; no shared pool of uses. The provider has no notion
  of who is covered (no guidance was found); quantities or several items on one subscription
  could carry several holders, but its portal cannot change a subscription of several products,
  so one subscription per holder is proposed (**guess**).

### What a member sees and does
| | Web | App |
| --- | --- | --- |
| Their memberships and passes, uses left this week, expiry | yes | yes |
| Buy a pass, start or change a membership | yes | no (`noPurchase`) |
| Update the card, see invoices | provider's portal | no |
| Cancel at period end, resume | yes | no (**guess**, as in 32a) |
| Ask for a pause | if question 10 allows | no |

### Staff side, from the host
- Subscriptions, memberships, passes and allowance uses in the admin with lists, record pages and
  saved views: "Active members", "Trials ending this week", "Past due", "Ending this month",
  "Passes expiring soon".
- A **Memberships** dashboard (and the Courses dashboard's subscription numbers): active
  subscriptions and trials, trials that became paid, cancellations and their reasons by month,
  recurring revenue by month net of tax, failing payments, uses spent per week.
- A Person's page gets a **Membership** tab: their subscriptions, memberships, passes and uses.
- Staff give a pass or extend one (`memberships.givePass`, permission grantable), cancel,
  pause (if allowed) and change plans for a member, with reasons; refunds through approval.

### The import door for members (stage 33 runs it)
- `cos memberships import <folder>`: people (the CSV import), passes with uses left and expiry,
  and memberships with their paid-up dates, as records with import keys, like `cos courses
  import`. Billing: see "Moving members' billing".

## Moving members' billing from another system
Cards cannot be moved between payment providers without the providers taking part, and nothing
here charges a card the member did not give to the company. The real options (question 14):
1. **A card data migration from the current processor to the company's Stripe account.** The
   company asks its current processor for an export and fills in Stripe's migration form; Stripe
   answers within 3 business days and sets up a secure transfer; the old processor uploads the
   card data encrypted to Stripe's key; the company approves what arrived; Stripe imports it and
   returns a mapping file, in about 10 business days after valid data arrives. The old
   processor's export itself "can take a few days to several months". CVCs, subscriptions and
   invoices are not imported. Each membership is then created on Stripe (its billing migration
   toolkit: a CSV of customer, price, a start date at least 24 hours ahead, billing anchor, trial
   end; or the schedules API for starts more than 30 days ahead), its first charge on the old
   one's next billing date, and the old billing is cancelled before it charges. Members do
   nothing; Stripe warns of more declines at first, because the merchant id changes.
2. **Each member subscribes again on the new site**, free until the date they have paid up to (the
   continuation offers of 32a), and the old billing ends at its period's end. Members act; some
   will not.
3. **Run both until the old memberships end**: new members on the new site only. Longest overlap.

Stage 33 owns the move (its interview picks the option and runs it); 32b provides the
continuation offers (option 2) and a subscription import from a migration's mapping file (option
1: from the migration's mapping file, a CSV for the provider's billing migration toolkit, one row a
member with its next billing date, checked by the host against the imported memberships first;
each new subscription is then found by its metadata and linked to its membership).

## What belongs to stage 31 or 33 instead
- **Stage 31:** the timetable (`recurring`), classes, appointments, rooms, booking and cancelling,
  waitlists, late-cancel and no-show rules (which moves return a use), check-in at a class, and
  declaring a booking a spender.
- **Stage 33:** importing the current system's clients, visit history, passes with uses left,
  memberships and schedules; moving their billing (option above); the period where both run.
- **Here:** what a member holds and how much of it is left; how it is paid for; the spend and
  give-back mechanism stage 31 calls.

## Out of scope
- Charges the host schedules itself (unless question 2 says otherwise).
- Fees charged to a stored card for a late cancel or a no-show (question 15).
- Coupons, discounts, referral credit, gift cards (stage 34).
- Invoices beyond the provider's own (stage 35).
- Buying or changing a membership in the app.
- More than one currency.
- Usage-based billing, add-ons on a subscription, several items on one subscription.

## Acceptance criteria
32a:
1. **Start with a trial:** against the fake provider, a visitor starts a course subscription; the
   provider's page takes the card and starts a trial; a verified event makes the subscription
   `trialing` and the visitor reads every published course's holders' parts, including a course
   published afterwards.
2. **One trial per Person:** a second trial for the same Person on a course plan is refused and the
   provider's page asks for payment at once.
3. **Host moves only:** every state move is made only from a verified event; a person, an MCP
   client, an extension and an import cannot move one; a repeated event changes nothing; an event
   that does not match the subscription moves nothing and tells staff.
4. **Each paid period is an order:** the trial's end and two renewals give two paid orders with
   the plan's price and the provider's tax figures; refunding one goes through approval and leaves
   the subscription as it was.
5. **Failing and ending:** a failed renewal moves it to `past_due` and access follows question 4's
   answer; the provider giving up ends it and access stops; cancelling at period end keeps access
   until the period's end and not a minute after; resuming before then keeps it running.
6. **Self-service:** a customer opens the portal for their own subscription only; cancels and
   resumes their own; cannot read or change another's; no native block calls a subscription
   operation (the block lint).
7. **The seam unchanged:** `subscription` is registered as an access kind and declared on
   `courses.course` with no change to `visibility/access.ts`'s seam, the holders' flag or
   `media.play`; stage 42's access tests pass unchanged.
8. **Continuation:** imported offers (with a re-run changing nothing) let a person subscribe with
   their first charge on their paid-up date and no 7-day trial; the report lists who has taken
   theirs.
9. **Tax:** with tax on, each period's invoice is taxed inside the price and the order stores the
   provider's figures; with it off, nothing about tax is sent.

32b:
10. **Allowance:** a holder of 3 uses a week refuses a fourth spend in the same week, for every
    actor and in the dry run; a spend in the next week succeeds; a returned use frees one; two
    spends at once for the last use, one succeeds (the stage 26 concurrency test's shape).
11. **Expiry and states:** a pass past its `until`, a paused membership and an ended one give
    nothing to spend; `auto` picks the holder that expires first.
12. **A subscription's grant follows it:** a membership is granted at the start, paused and
    resumed, and ended with its subscription, in each event's batch.
13. **Passes:** buying a pass grants it with its uses and expiry; a full refund voids it and keeps
    spent uses.
14. **Plan change and pause** behave as questions 10 and 12 decide, against the fake provider.
15. **Isolation:** the stage 22 isolation test covers subscriptions, memberships, passes and uses.
16. **Dashboard:** the Memberships dashboard's numbers match a fixture worked out by hand.
17. `pnpm lint typecheck test` and one e2e test per journey (start a course subscription with a
    trial; buy a pass and spend a use with the fixture spender) pass in CI; Stripe's test mode by
    hand with a runbook; ADRs, `CONTEXT.md` (Subscription, Membership, Pass, Allowance, Use,
    Continuation offer; "plan" disambiguated) and `docs/architecture.md` are updated.

## Dependencies
- Stages 25, 26, 27 and 42 (merged).
- Stage 31 for real spending (32b's spender is a fixture until then); stage 33 for the gym's move.

## Migrations and numbers
Migrations 0530 to 0549 (32a: `core_subscription`, its history, offers, the order's period
columns; 32b: `core_allowance_use` and its counters). ADRs 0485 to 0494. Claimed in
[`parallel-work.md`](../parallel-work.md) as block AG.

## Suggested build order
32a:
1. The gatekeeper's subscription checkout, events, cancel, resume and portal, for Stripe and the
   fake provider.
2. `core_subscription` and its host moves from verified events; the order per paid period; tax on
   each period.
3. The `subscription` access kind and `courses.plan`; the trial rule; self-service; the staff
   side for subscriptions.
4. Continuation offers; the first client's course subscribers move; Stripe's test mode by hand.
32b:
5. The `allowance` behaviour with a fixture spender, its concurrency test.
6. `recurring.grants`; the Memberships pack, passes; plan changes and pauses as decided.
7. Dashboard, views, the Person tab; hooks and blocks (web and native, native read only).
8. `cos memberships import` and the subscription import from a migration mapping, for stage 33.

Steps 1 to 3 are the spine of 32a; step 5 is the spine of 32b.

## Built: 32a steps 1 and 2 (2026-11-22)
ADRs [0485](../adr/0485-recurring-billing-the-provider-runs-the-schedule.md) (recurring billing,
the record, events as current reads, what was checked in Stripe's documentation),
[0486](../adr/0486-an-order-per-paid-period-and-its-refund.md) (an order per paid period, a
period's refund) and [0487](../adr/0487-the-payer-and-the-holder.md) (payer and holder), migration
0530. Where the build read the spec one way, or decided what it left open:

- **Events are current reads.** The gatekeeper stores a read of the subscription (and invoice)
  made with a pinned API version when the event arrives, not the event's payload: payloads are
  shaped by the webhook endpoint's own version, and Stripe does not deliver in order. The host
  moves from the latest read only.
- **The record exists once the provider says so.** `subscription.start` records a checkout
  (`core_subscription_checkout`); the first verified event makes `core_subscription` from it. The
  spec's "its history" is the transition engine's history rows, not a table of its own.
- **Cancel and resume are the gatekeeper's actions** (`payments.subscription.cancel`, `.resume`,
  never auto-approvable): the host's own call applies them at once, an agent's session waits for a
  person. `subscription.cancel` and `.resume` are `actors: ["human"]`. Ending one at once is in
  the gatekeeper, and its staff operation (`subscriptions:manage`) is step 3.
- **The portal** disables pausing too (`features[subscription_pause]`, new in Stripe's
  2026-10-28 version), as well as cancelling and plan changes.
- **A period's refund**: the spec's premise that only a credit note gives the tax back is wrong
  (Stripe Tax reduces it for a refund on an invoice's payment too); its guess that the credit
  note's tax reaches the host on its event is right. The build makes the refund, then a credit note
  linked to it, for the figure and the record (ADR 0486).
- **A paid period whose amount is not the agreed price** writes no order and tells staff.
- **Payer and holder** (question 13's answer): two columns from the start, the same Person in 32a
  (ADR 0487). The spec's "its Person" is the payer for billing and the holder for what it grants.
- **Not built in these steps:** the one-trial rule, the `subscription` access kind, `courses.plan`,
  the staff side and blocks (step 3); continuation offers (step 4, though the gatekeeper's
  `trialEnd` is in); updating live subscriptions when tax is turned on (the spec's guess; the
  provider's page on it was not read; step 4 with the test-mode runbook).
- **The one-trial rule must land before any pack declares a plan with a trial.** Until step 3
  adds it, `subscription.start` gives a plan's trial every time; no pack declares a plan, so only
  test fixtures can be subscribed to. Step 3 adds the rule (per holder, per plan object) before
  `courses.plan`.
- **Changed after review (2026-11-22)**, in ADRs 0485 to 0487: a guest never reuses another
  person's provider customer; terms changed at the provider apply only what reduces what the member
  holds, and every paid period is an order, flagged when not as agreed; a subscription this host
  did not start or cannot read is ignored (200, counted), not retried; the portal opens only for
  the host's own call; `subscriptions:manage` for staff; resume refuses an end date set at the
  provider; a period refund's credit note is retried, not "unknown"; a deleted provider customer
  is replaced; the fake provider runs off localhost only with its own secret.

### Step 4's test-mode runbook: open checks
Checked by hand in Stripe's test mode before the course subscribers move, none verifiable from the
documentation alone:
- that an amount-only credit note on an automatic-tax invoice returns `total_taxes` (if it comes
  back empty, the host keeps the refund's tax unknown, never a precise zero: built so already);
- that the account accepts the pinned `Stripe-Version: 2026-11-18.endive`;
- that the portal configuration's `features[customer_update][allowed_updates]` list is accepted as
  sent;
- that `DELETE /v1/subscriptions/:id` takes `cancellation_details[comment]` in a form body;
- that a credit note linked to an existing refund (`refunds[0][refund]`, `amount` equal to it) is
  accepted on an invoice paid in full;
- the company's provider settings: retries exhausted → "cancel the subscription"; failed-payment
  and expiring-card emails on (decisions 4 and 6);
- that `GET /v1/checkout/sessions/:id` answers `status` `open`, `complete` or `expired` with the
  pinned version (the host asks it before giving a trial again over an earlier page, ADR 0489);
- that nobody pauses collection (`pause_collection`) in the dashboard: Stripe keeps such a
  subscription `active`, and the host keeps giving access (staff use the host's pause, 32b).

## Built: 32a step 3 (2026-11-22)
ADRs [0488](../adr/0488-the-subscription-access-source.md) (the `subscription` access source),
[0489](../adr/0489-one-free-trial-per-person-per-plan.md) (one trial per Person per plan object)
and [0490](../adr/0490-the-course-plan-self-service-and-the-staff-side.md) (`courses.plan`,
members' self-service, the staff side), migration 0531. Where the build read the spec one way, or
decided what it left open:

- **Access** follows the holder; on trial, active and past due (decision 4); set to end, until the
  period's end and not a minute after, even before the provider's event; nothing while unpaid,
  paused or incomplete. `plans` must be a plan object of the same extension; `covers: "all"` only.
  The seam, the holders' flag and `media.play` are unchanged.
- **The trial is a proved holder's only** (a signed-in customer, or staff for a Person). A guest
  who typed an address is charged from the start (`noTrial: "sign_in"`): otherwise a guest could
  spend someone else's trial, and the page would tell a stranger whether that person had one. A
  company offering trials to new visitors turns on "anyone starting a subscription" (ADR 0459),
  or customer sign-up `open`, or invites them.
- **When the trial counts**: when the provider's verified event confirms a subscription opened
  with the plan's trial, not when a page is opened. A checkout with a trial holds it; a hold is
  released only when the provider says its page expired uncompleted (the host asks the gatekeeper,
  `getSubscriptionCheckout`), a completed one uses the trial, and if the provider cannot be asked
  no trial is given now (`noTrial: "unconfirmed"`). The database refuses a second unreleased hold,
  so two starts at once give one trial. A page goes back, with the terms it was opened with, only
  to whoever opened it and only while it is open; anyone else gets a fresh page with no trial.
- **Staff give a trial** only with `subscriptions:manage`, as a person (`noTrial: "permission"`
  otherwise).
- **A person merge** moves subscriptions, their checkouts and trials to the survivor (ADR 0487).
- **With no event**: past due gives access only for 30 days of failing (staff told once); an
  active subscription whose period ended 3 days ago with no event keeps access, and staff are told
  the provider's events are not arriving.
- **Decided by the owner (2026-11-22):** a new visitor will get the trial by confirming their
  email with a code first (a new customer sign-in setting, "anyone starting a subscription", set
  by a human admin, ADR 0458), built by a separate identity session after this step; until then a
  guest gets no trial, and the subscribe block's `sign_in` notice is where it joins. Since built
  ([ADR 0459](../adr/0459-anyone-starting-a-subscription.md)): a switch on top of the sign-up
  mode, on while a plan is on sale to the public; the visitor confirms the code on the plan (the
  block's `signIn`) and goes on to the provider's page with the trial. A
  continuation's free time is not the trial: only a checkout with the plan's trial days uses it
  (ADR 0489).
- **Staff** end one at once with `subscription.cancel { now: true }` (`subscriptions:manage`;
  a customer is refused). Deviation: an AI does not propose a cancel (the spec said it may):
  cancel and resume stay `actors: ["human"]`, as steps 1 and 2 built them.
- **The app** is read only for billing, and the block lint now holds every native block to it
  (not only those marked `noPurchase`).
- **Staff views** are the admin's Subscriptions section (all, trials, failing, ending) and a
  Person's page, not saved views of the generic list (the subscription is outside it, as Order is).
- **Not built in this step:** continuation offers and the subscribers' move (step 4: it must open
  a continuation with `trialEnd`, never trial days, so it writes no trial row); the sign-in
  setting for new visitors (the identity session).

## Built: 32a step 4 (2026-11-22)
ADRs [0491](../adr/0491-continuation-offers.md) (continuation offers: who takes one, used once,
the import, the report) and [0492](../adr/0492-a-continuation-replaces-the-trial.md) (the free time
and the trial; dates under 48 hours or past), migration 0532, and the test-mode runbook
[`docs/subscriptions-stripe-runbook.md`](../subscriptions-stripe-runbook.md) with every open
check above. Where the build read the spec one way, or decided what it left open:

- **The operation's name.** The spec's `subscription.offers.import` is `subscription.offer.import`,
  beside `subscription.offer.list`, `.export`, `.withdraw` and `.mine` (a customer's own); an offer
  is taken with `subscription.start { offerId }`. The command is `cos subscriptions offers import
  <offers.csv> --plan <object>[:<id>]` (and `cos subscriptions offers report`).
- **"`record.import`'s rules"** are kept, not the operation: an offer is a core row, not an
  extension record. The address is the key (per plan object); a dry run; a re-run changes nothing;
  an offer taken, withdrawn or holding a page is a conflict, kept. People are matched by address
  and never created (the courses import's rule).
- **Who takes one:** only the customer signed in as the offer's address (and its Person). A guest
  who types the address and staff for someone are refused; another address of the same Person
  finds nothing. Used once (the verified event marks it taken); two takes at once open one page (a
  trigger, as for the trial's hold); expires on its date; withdrawn by staff.
- **Sign-in:** the spec's "sign-up mode `buyers` or an invite lets them" is half right: `buyers`
  does not (an imported person has bought nothing here). `open` does, or an invite: the import's
  `--invite` invites each address (`users:manage`), so `invite_only` and `buyers` work too. No
  sign-in change was made here. With the sign-in setting "anyone starting a subscription" on
  (ADR 0459) and a plan on sale, any address may get a code, so imported subscribers sign in
  without invites, by the subscribe block's code step, and then see their offer.
- **Free time and the trial (decision 7 and the owner's):** the continuation replaces the trial, is
  not the trial (no trial row). No trial while the holder has an offer they can still take or a
  subscription from one that has not ended (`noTrial: "continuation"`); after it has ended, or the
  offer expired untaken, the one-trial rule applies, so a returning former subscriber can have the
  trial once (the owner's answer, corrected before merge). With under 48 hours (and 15 minutes)
  left, taking it is charged at once with no trial; once the date has passed it cannot be taken and
  they subscribe as anyone. The import and the report say so.
- **The paid-up date** is 00:00 that day in the organisation's time zone, or a moment with its
  offset.
- **The report:** who took theirs and when their new subscription starts charging, who has not, a
  subscription started another way; the admin's Subscriptions → Continuation offers with Download
  CSV and withdraw, and `cos subscriptions offers report`.
- **The member:** the subscribe block shows a signed-in member's offer ("Continue, free until
  <date>") in place of the trial, and no trial on any plan; the native block says it in words, to
  take on the web. A trialing subscription now reads "Free until <date>" for both a trial and a
  continuation.
- **After review (2026-11-22)**, in ADR 0491: an abandoned checkout no longer blocks a correction
  (the provider is asked, an expired page released); staff reissue a withdrawn address only with
  `--reissue`; impossible dates are refused; every change to an offer is from a current read (a
  version and a trigger, so a take, an import or a withdrawal racing another fails whole and is
  sent again); the block never sends a member with free time owed to a page that charges today
  without saying so, and an offer whose plan is gone follows to the object's only live plan or
  says "ask us" while staff are told; invites are recorded; the report is a person's (not on MCP).
- **Not built here:** the first client's subscribers' move is the client's own setup (its export,
  its list, telling its people), outside this repository. Nothing was run against Stripe; the
  runbook is for the owner. Updating live subscriptions when tax is turned on (the spec's guess,
  left in steps 1 and 2) is still not built.

## Questions for the interview
Ordered by how much each changes the build; 32a's first. All were decided on 2026-11-22:
1 to 7 as recommended; 8 with every option (time-of-day limits are stage 31's to carry).

1. **Split the stage, and ship the course subscription first?**
   - (a) One stage: subscriptions, allowances and Memberships together.
   - (b) 32a (the subscription, the course plan, the course subscribers' move) first; 32b
     (allowances, Memberships) after, with stage 31.
   - (c) 32a and 32b in parallel sessions from the start.
   **Decided 2026-11-22: (b)**, as recommended. **Recommended: (b).** The online program's move is waiting only on 32a, and 32a needs nothing
   from 32b; 32b's main spender (bookings) does not exist yet, and building it beside 31 lets the
   two meet on a real booking instead of a fixture alone.

2. **Who runs the schedule: the provider or the host?**
   - (a) The provider: it keeps the card, charges each period, retries, emails, and ends the
     subscription; the host mirrors verified events.
   - (b) The host: cards saved at the provider, charges scheduled and retried by the host's cron.
   - (c) The provider for the course subscription, the host for gym memberships.
   **Decided 2026-11-22: (a)**, as recommended. **Recommended: (a).** It keeps stage 25's rule that nothing on the platform charges a card on
   its own, and it buys retries, card updates, 3D Secure on renewals, proration and pauses from
   the provider instead of writing them. Its cost is the provider's billing fee on recurring
   volume, which the company pays (**check at build**). (b) is a payments system of our own.

3. **Is every paid period an order?**
   - (a) Yes: a paid order per period, created by the host from the verified invoice event.
   - (b) No: the subscription keeps its own payment rows; revenue is read from two places.
   **Decided 2026-11-22: (a)**, as recommended. **Recommended: (a).** Revenue, tax figures, refunds, the confirmation email, `rec_order` and every
   dashboard stay one path; a refund of a month is a refund of an order, through approval, as
   built.

4. **What does a member keep while a renewal is failing?**
   - (a) Everything, while the provider retries; access and uses stop when it gives up.
   - (b) Nothing from the first failure until it is paid.
   - (c) A set number of days' grace (for example 7), then nothing until paid.
   **Decided 2026-11-22: (a)**, as recommended. **Recommended: (a)**, with the provider's retry window left at its default (Smart Retries: up to
   8 retries within 2 weeks). Most failures are a card that has expired or a bank's refusal that clears; cutting
   a member off at the first failure makes the gym's front desk the dunning team. The setting for
   what happens when retries run out should be "cancel", so the host sees the end.

5. **How do members manage their billing?**
   - (a) The provider's portal for the card and past invoices; our own web blocks for cancel and
     resume (and, in 32b, pause and plan change), through host operations.
   - (b) The provider's portal for everything, configured by the company.
   - (c) Our own blocks for everything except typing a card.
   **Decided 2026-11-22: (a)**, as recommended. **Recommended: (a).** Cancelling, pausing and changing plan carry the host's rules (one trial,
   allowances, a commitment, reasons for staff), so they should be host operations the company's
   screens call; the card is the provider's job.

6. **Who emails a member about a failed payment or a card about to expire?**
   - (a) The provider, from its own settings, with the company's branding.
   - (b) The host, through the email connection, from its own templates.
   **Decided 2026-11-22: (a)**, as recommended. **Recommended: (a)** for 32a. The provider can send an email after each failed card payment with
   a link to update the card, one a month before a card expires, a reminder 7 days before a trial
   ends, and a link to confirm a payment that needs 3D Secure; it knows when it retries. The host
   tells staff. (b) can follow if the company wants the messages in
   its own voice.

7. **Does a course subscriber's free continuation replace the 7-day trial?**
   - (a) Yes: free until their paid-up date, then charged; no trial on top.
   - (b) No: the 7-day trial is added after their paid-up date.
   - (c) Only when their paid-up date is less than 7 days away, the trial instead.
   **Decided 2026-11-22: (a)**, as recommended. **Recommended: (a).** They are not trying the program, they are continuing it; (b) gives every
   moving subscriber a free week the company did not decide to give.

8. **What does the gym sell?** *Decided 2026-11-22: (c) (32b).* (32b; the model depends on it)
   - (a) Unlimited memberships, memberships of N classes a week, and class packs of N visits that
     expire.
   - (b) As (a), plus drop-ins and an intro offer (a cheap first pass, once per person).
   - (c) As (b), plus limits by time of day or by class type (off-peak, open gym only).
   **Recommended: (b), confirmed against the gym's current price list before 32b starts.** A
   drop-in is a pass of one; an intro offer is a pass type limited to one per Person, the same rule
   as the trial. Class-type limits are in the model (`spendsOn`); time-of-day limits would need
   the booking's time, which is stage 31's, so (c) is a 31 question.

9. **Do unused weekly or monthly uses carry over?** *Decided 2026-11-22: (a) (32b).*
   - (a) No: each period starts fresh.
   - (b) Into the next period only.
   - (c) They bank up to a cap.
   **Recommended: (a).** It is the common rule and needs no balance to explain; (b) and (c) need a
   ledger of carried uses and make "how many have I got" a calculation.

10. **Can a membership be paused (frozen)?** *Decided 2026-11-22: (b) (32b).*
    - (a) No.
    - (b) Yes, by staff, for a set time (a minimum and maximum the company sets), nothing charged
      and nothing spent meanwhile.
    - (c) Yes, and members can ask for one themselves on the web, within the company's limits.
    **Recommended: (b).** Gyms freeze for injury and travel; the provider's `paused` status stops
    invoices and the host stops access and uses; staff deciding keeps it from being a way to skip
    paying. (c) is a block and a rule more, later (the provider's own portal pause allows one pause
    in 12 months and starts at the period's end, which may not be the gym's rule).

11. **Do memberships have a minimum term or a notice period?** *Decided 2026-11-22: (a) (32b).*
    - (a) No: cancel any time, effective at the period's end.
    - (b) A minimum term (for example 3 or 12 months), with early ending only by staff.
    - (c) A notice period (a cancellation takes effect after N days).
    **Recommended: (a), unless the gym's current contracts have one,** in which case the members
    moved by stage 33 keep theirs. A term is the provider's subscription schedule (a phase of 12
    months, then released to run on) and a rule in the host's cancel; a subscription with a
    schedule cannot be changed or cancelled in the provider's portal, and pauses are refused while
    one is attached. It should be built only if it is sold.

12. **When does a plan change take effect?** *Decided 2026-11-22: (c) (32b).*
    - (a) At the next period, with no proration.
    - (b) At once, prorated by the provider.
    - (c) Upgrades at once, prorated; downgrades at the next period.
    **Recommended: (c).** A member who upgrades wants the classes now and pays the difference; a
    downgrade mid-period would hand back money for uses already spent.

13. **Can one person pay for another's membership?** *Decided 2026-11-22: (b) (32b).*
    - (a) No: each person holds and pays for their own.
    - (b) Yes, a payer and a holder (a parent pays for a child), each holder with their own
      allowance.
    - (c) Yes, and a family shares one pool of uses.
    **Recommended: (b) only if the gym sells it today, otherwise (a).** (b) is a second Person on the
    subscription and in the seam's reads; (c) is a shared counter and a question of who spent what.

14. **How do the gym's members' cards and billing move?** *Decided 2026-11-22: (a), (b) the fallback (32b).* (stage 33 runs it; 32b builds the means)
    - (a) The current processor exports the card data to the company's Stripe account through
      Stripe's migration process, and each membership is recreated with its first charge on its
      next billing date.
    - (b) Each member subscribes again on the new site, free until their paid-up date (the
      continuation offers of 32a).
    - (c) Old memberships run on the old system until they end; new members on the new site only.
    **Recommended: ask the current provider about (a) now, and plan (b) as the fallback.** (a)
    needs nothing from members, which matters for a gym's whole membership, but depends on the
    current processor agreeing and on weeks of lead time; (b) is already built by 32a; (c) keeps
    two systems for as long as the longest member stays.

15. **Can a late cancel or a no-show cost money?** *Decided 2026-11-22: (a) (32b).* (stage 31's rule, 32's mechanism)
    - (a) No money: it keeps the use (the use is not returned).
    - (b) A fee charged to the member's saved card by the host.
    - (c) A fee added to their next invoice by the provider.
    **Recommended: (a).** It needs nothing beyond the allowance; (b) would make the host charge a
    card on its own, which the platform does nowhere; (c) is possible later with the provider's
    invoice items, once a fee is actually wanted.

16. **Build "pick any three" courses now, on the allowance?** *Decided 2026-11-22: (b) (32b).*
    - (a) Yes: a course credit pass of N, spent by choosing a course, which grants its enrolment.
    - (b) No: fixed bundles only, as stage 42 has.
    **Recommended: (b) unless it is sold today.** It is a good second spender to prove the
    behaviour, but the fixture spender proves it too, and stage 42's interview chose fixed bundles.

## Sources
Read 2026-11-22 and 2026-11-23. Stripe's documentation is the provider's; nothing about its API
here is from memory.

- In this repository: ADRs 0427 to 0429, 0435, 0458, 0477 (`registerAccessSource`), 0478, 0479
  and 0480; `packages/core/src/visibility/access.ts`, `packages/core/src/orders/`,
  `packages/gatekeeper-payments/src/`; stage 42's spec, "Decided for stage 32".
- Checkout and trials:
  [free trials in Checkout](https://docs.stripe.com/payments/checkout/free-trials),
  [Checkout Session create](https://docs.stripe.com/api/checkout/sessions/create)
  (`payment_method_collection`, `subscription_data`, `automatic_tax`),
  [free trials](https://docs.stripe.com/billing/subscriptions/trials/free-trials) (end behaviour,
  the invoice at the trial's end),
  [trial offers compared](https://docs.stripe.com/billing/subscriptions/trials/compare).
- Subscriptions and events:
  [how subscriptions work](https://docs.stripe.com/billing/subscriptions/overview) (statuses,
  23 hours, provisioning),
  [subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks).
- Failed payments and emails:
  [Smart Retries](https://docs.stripe.com/billing/revenue-recovery/smart-retries),
  [pause on payment failure](https://docs.stripe.com/billing/revenue-recovery/smart-retries/pause-on-payment-failure),
  [customer emails](https://docs.stripe.com/billing/revenue-recovery/customer-emails),
  [hosted invoice page](https://docs.stripe.com/invoicing/hosted-invoice-page).
- The portal:
  [customer management](https://docs.stripe.com/customer-management),
  [configure the portal](https://docs.stripe.com/customer-management/configure-portal),
  [integrate the portal](https://docs.stripe.com/customer-management/integrate-customer-portal),
  [deep links](https://docs.stripe.com/customer-management/portal-deep-links),
  [portal pauses](https://docs.stripe.com/customer-management/pause-subscriptions).
- Changes, pauses, cancellation:
  [change price](https://docs.stripe.com/billing/subscriptions/change-price),
  [prorations](https://docs.stripe.com/billing/subscriptions/prorations),
  [billing cycle](https://docs.stripe.com/billing/subscriptions/billing-cycle),
  [schedules](https://docs.stripe.com/billing/subscriptions/subscription-schedules) and
  [their uses](https://docs.stripe.com/billing/subscriptions/subscription-schedules/use-cases),
  [pause payment collection](https://docs.stripe.com/billing/subscriptions/pause-payment),
  [pause a subscription](https://docs.stripe.com/billing/subscriptions/pause),
  [cancel](https://docs.stripe.com/billing/subscriptions/cancel).
- Refunds and tax:
  [credit notes](https://docs.stripe.com/invoicing/dashboard/credit-notes),
  [collect taxes on subscriptions](https://docs.stripe.com/billing/taxes/collect-taxes?tax-calculation=stripe-tax),
  [tax codes and tax behaviour](https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior),
  [product tax codes](https://docs.stripe.com/tax/tax-codes).
- Moving subscriptions and cards:
  [migrate subscriptions](https://docs.stripe.com/billing/subscriptions/migrate-subscriptions),
  [billing migration toolkit](https://docs.stripe.com/billing/subscriptions/import-subscriptions-toolkit),
  [import with the API](https://docs.stripe.com/billing/subscriptions/import-subscriptions),
  [card data from another processor](https://docs.stripe.com/get-started/data-migrations/pan-import),
  [copy between Stripe accounts](https://docs.stripe.com/get-started/data-migrations/pan-copy-self-serve).
- Several items and quantities: [quantities](https://docs.stripe.com/billing/subscriptions/quantities).
- Pricing: [Stripe Billing pricing](https://stripe.com/billing/pricing) (the page served was one
  region's; 0.7% of billing volume, pay as you go).

Not found or not confirmed: Billing's price in every region; Stripe Tax's fee on renewals; a
sentence saying tax is recalculated on every renewal (the documentation implies it); the default
days of `invoice.upcoming`; any guidance on family or multi-person memberships; pause schedules'
details (linked, not read); the page on updating existing subscriptions for tax (seen only as a
search result); whether a credit note's tax figure reaches the host on its event; how the first
client's current booking system and processor export card data, and how long they take; the
gym's actual price list (question 8).
