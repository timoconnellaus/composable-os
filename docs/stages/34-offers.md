# Stage 34: Price adjustments and Offers

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Orders,
with Tax at checkout and Subscriptions; Behaviours), [`CONTEXT.md`](../../CONTEXT.md) (Order,
Sellable, Grant, Code, Hold, Intro offer, Subscription plan, Continuation offer, Refund, Refund
owed, Deposit, Tax at checkout), ADRs
[0402](../adr/0402-staff-and-customers.md) and [0404](../adr/0404-behaviours-are-the-vocabulary.md),
[0427](../adr/0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md) to
[0429](../adr/0429-payments-gatekeeper-verified-events-and-refunds.md) (orders priced by the host,
paid only by a verified payment; guests; refunds),
[0435](../adr/0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md) (sellable and
grants), [0449](../adr/0449-permissions-granted-one-by-one.md) (permissions granted one by one),
[0458](../adr/0458-customer-sign-in-for-buyers.md) (customer sign-in for buyers),
[0479](../adr/0479-tax-at-checkout.md) (tax at checkout),
[0480](../adr/0480-an-ai-asks-to-publish-a-person-approves.md) and
[0552](../adr/0552-a-tool-a-person-approves.md) (an AI asks, a person approves),
[0485](../adr/0485-recurring-billing-the-provider-runs-the-schedule.md) to
[0492](../adr/0492-a-continuation-replaces-the-trial.md) (subscriptions, an order per paid period,
one trial per Person, continuation offers),
[0506](../adr/0506-a-spender-paid-another-way.md) (a spender paid another way: a mark on a
booking, not money on an order), [0510](../adr/0510-what-a-subscription-grants.md) to
[0512](../adr/0512-one-per-person-and-tools-only-a-person-may-call.md) (what a subscription grants,
passes, one per Person), [0530](../adr/0530-plan-changes-upgrade-now-downgrade-next-period.md)
(plan changes), [0560](../adr/0560-a-paid-line-moves-a-record-that-exists.md) (a paid line moves a
record), [0590](../adr/0590-routine-mail.md) (routine mail) and
[0625](../adr/0625-restricted-pack-permissions.md) (restricted pack permissions); issues
[#102](https://github.com/timoconnellaus/composable-os/issues/102),
[#125](https://github.com/timoconnellaus/composable-os/issues/125) and
[#225](https://github.com/timoconnellaus/composable-os/issues/225); stage
[44](44-agreements.md) (agreements due at purchase) and stage [47](47-pack-screens.md) (pack
screens); `packages/core/src/orders/` (`orders.ts`, `tax.ts`, `payments.ts`, `checkout.ts`,
`refunds.ts`, `refund-due.ts`, `once.ts`, `grants.ts`, `moves.ts`),
`packages/core/src/subscriptions/` (`subscriptions.ts`, `periods.ts`, `changes.ts`, `trial.ts`,
`offers.ts`), `packages/core/src/customers/accounts.ts` and `packages/core/src/rate-limit.ts`.

Status: **spec agreed** (owner interviewed 2026-11-24: decisions 1 to 10; decisions 11 to 13 by
the coordinator the same day, under the owner's standing rule). Build may start with
steps 1 and 2. Step 11, loyalty, is in the stage's scope but is not built until its own short
interview settles its shape (the first question at the end). The shared platform step "an order
paid another way" (step 3) is shared with stage 35 (invoices and quotes) and the point of sale
module (the till): whichever is built first builds it once, to this design.

## Status

- **Step 1, adjustments and the pricing seam** (`feat/stage-34-adjustments`, migration 0950, ADRs
  0690 and 0691): `core_order_adjustment` (kept as given: only marked removed, or a reason blanked
  by erase), each line's `line_discount`, the order's `discount` and its `total` after
  adjustments; `applyAdjustments` (`orders/adjustments.ts`) as the adjustment stage after
  `priceLines`, used by `createOrder` and by every change to a pending order's adjustments; the
  checkout's tax shares split over the net lines; a deposit kept and taken off the balance (one a
  discount leaves at or above the total is not taken: pay in full); `rec_order.discount`,
  `rec_order_line.line_discount` and `line_net`, `rec_order_adjustment`. `order.adjust` and
  `order.unadjust` (`orders:discount`, a new grantable core permission), the human admin's
  `discountLimit` setting (nothing until set: every staff discount waits), a new operation option
  `reviewWhen` that queues a person's call over the limit, an AI's call always queued, approval by
  a human admin only, and the checkout refused while a discount waits. Refunds and refunds owed
  needed no change: they give back what was paid, which is the net. Deviations: an adjustment
  cannot take an order to nothing until step 3 adds a way to pay one (the spec lets a staff
  adjustment make an order free); a price changes only before the order's checkout has opened; the
  spec's ADR table had staff discounts as 0693, this step was given 0690 and 0691, so staff
  discounts are 0691 and the `discount` behaviour moves to 0693 (table below). Left for later
  steps: codes, members' prices and referrals as adjustments (4, 5, 9), the order's adjustments
  and "Give a discount" on staff screens (10), e2e journeys (10). After the PR's review: migration
  0951 makes a discount and the buyer's payment page unable to cross; the limit is judged again on
  the handler's read; an AI's `order.unadjust` waits for an admin; erase redacts the discount
  calls' audit rows; a whole-order percentage gives each line its own rounded-down share; only a
  person's waiting discount holds the checkout, not an AI's.
- **Step 2, folding plus addresses** (branch `feat/stage-34-address-folding`, issue #225;
  migration 0955, ADR 0692, amending 0489 and 0512): `core_person_emails.folded` kept by triggers
  (the `+tag` dropped on every domain, dots kept), `foldAddress` and `samePeople` in
  `customers/accounts.ts`; free trials (`subscriptions/trial.ts`) and things sold once per Person
  (`orders/once.ts`) count every live Person sharing a folded address, and two triggers refuse the
  second of two holds at once by such People. A pass given by hand stays per Person (a person's
  override). Left for later steps: per-person codes and the new-customer check (step 4) and
  referrals (step 9) read `samePeople`; migrations 0956 and 0957 of this step's range are unused.

## Goal

A business can give money off, and say why, everywhere it sells: a promo code typed at checkout on
the website for a campaign, members' prices on drop-ins, event tickets and courses with no code,
a discount the desk gives with a reason (up to a limit, approval above it), the first month of a
membership or the first three months off, a gift for a friend (one named thing, or a money amount
spent on anything), and a member inviting a friend so both get something. Every discount is an
adjustment on the order (how much, which discount or which person gave it, and why), the payment
provider charges and taxes the reduced amount, refunds give back what was paid, the way it was
paid, and the owner sees what each discount cost and what it brought in. Nothing charges a card
on its own, and nobody gets a "one per person" deal twice by typing `name+2@` for their address.

## Who it is for

**Gyms and studios first.** The owner did not say what the gym does today; the interview's chat
proposed what studios like this usually run, and the owner asked for all of it (decision 1): the
intro offer for new people (already built, ADR 0512), a promo code for a campaign or a season, a
bring-a-friend scheme, a staff discount at the desk, gift vouchers, members' prices, and loyalty
later.

**Trades and services** (the next vertical) need the same primitive in a different place: a
discount on a quote or a job given by a person with a reason (stage 35 uses this stage's
adjustment), a customer rate for an organisation or a group applied automatically (the same
mechanism as a member's price), referrals rewarded only once the friend's job is paid in full (a
deposit is not enough), and payments recorded by a person (a bank transfer, stage 35; cash, the
till), which is the same platform change as a gift card here.

## What exists today (from the code, checked 2026-11-24)

- **Orders are priced only by the host.** `orders/orders.ts`: `priceLines` reads each line's
  price from the record; `createOrder` sums line totals, refuses an order with nothing to pay
  (`rule: "total"`), works out the deposit from the records, and writes `core_order` and
  `core_order_line` (`unit_price`, `line_total`, `tax_amount`, `tax_code`; schema in
  `packages/db/src/schema.ts`). No input carries a price. There is no discount anywhere.
- **Tax** (`orders/tax.ts`, ADR 0479): prices include tax; `splitInProportion` splits each payment
  over the lines by their totals, and the checkout sends each share with its product tax code to
  the provider, which works out the tax. The host never calculates tax.
- **One way to be paid** (`orders/payments.ts`, ADR 0427): `applyVerifiedPayment` is a function,
  not an operation; only the gatekeeper's verified event reaches it, through
  `order.applyPaymentEvent` (`actors: ["automation"]`, input only the stored event's key).
  `core_order_payment` is keyed by provider and event id; every row today is the provider's.
  `chargeFor` decides what a checkout may ask for, and a payment that does not match is recorded
  and staff are told. Bookings' "paid another way" is a mark on a booking, not money on an order
  (ADR 0506).
- **Refunds** (`orders/refunds.ts`, `orders/refund-due.ts`, ADR 0429): what can go back is what was
  paid on each payment, always through the provider, approved by a person with `orders:refund`
  (never an AI). A drop-in's refund owed uses the line's amount.
- **One per Person** (`orders/once.ts`, `core_sellable_once`, migration 0581): held at the order's
  start, used when paid, given back when the unpaid order expires or is cancelled; a guest is
  refused with the same answer for every address. Every limit here reuses this shape.
- **Subscriptions**: `subscriptions/subscriptions.ts` starts one with an amount and an optional
  trial or free-until date; `subscriptions/periods.ts` writes an order per paid invoice and flags a
  period paid less ("a coupon or the payer's balance at the provider, say", `paid_less`), so a
  coupon put on at the provider today shows as a problem; `subscriptions/changes.ts` (plan
  changes, ADR 0530) already reads a renewal's amount as possibly changed by a coupon or credit.
- **Trials and continuation offers** (`subscriptions/trial.ts`, `subscriptions/offers.ts`): free
  time, not a discount; they stay as they are.
- **Addresses**: `customers/accounts.ts` `normaliseCustomerEmail` trims and lower-cases; it does
  not fold `+tags`, so `a+1@` and `a+2@` are two People and each gets a trial (issue #225).
- **Grants and codes** (`orders/grants.ts`): a paid line can grant a record with an unguessable
  code (a ticket). A gift voucher for a named thing is the same shape.
- **What is sold**: Ticketing's ticket types, Memberships' plans and pass types, Courses' courses,
  bundles and the course plan, Bookings' drop-ins through `order.startHeld` (`orders/moves.ts`).
- **Permissions**: core permissions are held by admins and granted one by one by a human admin
  (`GRANTABLE_PERMISSIONS` in `packages/core/src/principals.ts`, ADR 0449); `orders:refund` is the
  model for the new ones here.
- **Rate limits** (`packages/core/src/rate-limit.ts`) for anything the public can try; **routine
  mail** (ADR 0590) for the emails a shipped pack sends without approval.

## Decided at the interview (2026-11-24)

| # | Decision |
| --- | --- |
| 1 | Build all of these: a **promo code** for a campaign or a season, **bring-a-friend referrals**, a **staff discount at the desk**, **gift vouchers**, **members' prices** applied automatically, and **loyalty**. The intro offer stays as built. (The owner skipped "how do you give money off today" and asked in the chat for everything proposed, loyalty points and automatic member prices included) |
| 2 | **A gift is either**: a gift of **one named thing** (a month's membership, a 10-class pass, a ticket), **or a money amount** the friend spends on anything. Both are built |
| 3 | What the inviting member gets is **chosen for each referral scheme**: money off their next membership payment, a free class pass, or a gift voucher for something the business chooses |
| 4 | The member gets their reward **once the friend has paid and not asked for their money back for 14 days**. Suspicious cases (same card, same address) are held for staff |
| 5 | **Staff may give a discount at the desk on their own, up to a limit the owner sets**; anything above it waits for the owner's approval |
| 6 | A code takes money off a membership for **the first payment only, or a set number of payments** (the first three months, say). Not every payment for as long as they stay |
| 7 | **`name+1@` and `name+2@` count as the same person**, so nobody gets a free trial, an intro deal, a one-per-person code or a referral reward twice that way (issue #225) |
| 8 | **Members automatically pay less for some things** (drop-in classes, event tickets, courses) without typing a code; the business chooses what it covers and how much |
| 9 | **One deal per purchase**: when a code and a members' price both apply, the better one for the customer applies. Staff can still add their own discount on top |
| 10 | **Loyalty is not in the first build.** It is a later step of this stage (decision 1), built after its own interview |

### Decided by the coordinator (2026-11-24, under the owner's standing rule)

The owner's standing rule: where the answer is best practice, it is decided and recorded, not
asked. Three of the spec's open questions were decided so:

| # | Decision |
| --- | --- |
| 11 | **Gift cards are sold in set amounts the business chooses** (one gift card type record per amount), not an amount the buyer types: the host prices every order from a record |
| 12 | **Free postage over an amount still applies alongside a code or a members' price**: it is the delivery option's rule, not the one deal |
| 13 | **A partial refund of an order paid partly by gift card goes back to the card first**, then onto the gift card; staff may choose otherwise when they ask for the refund |

## The design in one page

- **An adjustment is money off an order, kept by the host.** `core_order_adjustment`: the order,
  the line it is on (or the whole order, spread over the eligible lines in proportion with
  `splitInProportion`), the amount taken off in minor units, its kind (`code`, `automatic`,
  `staff`, `referral`), the discount it came from or the person who gave it, and why. Each line
  keeps its **net** total, and the order's `total` is what is owed after adjustments. Everything
  downstream reads the net: the checkout, the provider's tax shares, deposits, refunds owed,
  reports.
- **The pricing seam.** One host function, `priceLines` (`orders/orders.ts`, the function that
  prices lines today and where [stage 37](37-shop.md) prices the delivery line), prices an order's
  lines, then its adjustments, then its delivery, and returns the net lines and total.
  `createOrder` calls it, and so does stage 37's public dry run `order.quote`, so a basket and the
  order it becomes never disagree. Whichever of this stage's step 1 and stage 37's delivery step
  (its step 3) lands first changes it; the other adds its part to it. Free postage over an amount
  is the shop's delivery option's own rule (stage 37, decision 5), not a discount; this stage
  decides only how it meets a deal (rule 8 below).
- **A new behaviour, `discount`, is how a pack declares discounts.** Like `sellable`, an object
  declares it and names its fields (what is off, on what, for whom, when, how often, for how many
  periods). The host reads the record at pricing time and enforces every rule. The Offers pack
  declares the objects and screens and never touches an order.
- **Codes are typed by the buyer; automatic discounts apply themselves.** `order.start`,
  `order.startHeld` and `subscription.start` take an optional `code`. A member's price or an
  organisation's rate applies without one when the buyer qualifies. **One deal per order, the
  better for the buyer** (decision 9), plus any staff adjustment.
- **Limits are kept by the database**, on `once.ts`'s shape: a use is held at the order's start,
  used when paid, released when the unpaid order ends. Total uses, uses per Person, new customers
  only, a minimum spend, a window of dates. "Per Person" uses the **folded address** (decision 7),
  and the same fold fixes trials and intro offers.
- **Staff discounts** are `order.adjust` on a pending order by a person with `orders:discount`,
  with a reason, up to a limit a human admin sets; above it
  a human admin approves in the Approvals inbox. An AI may ask; it never approves (decision 5).
- **Subscriptions**: a code on a plan takes money off the first period or a set number of periods
  (decision 6). The gatekeeper puts that discount on the subscription at the provider, and
  `periods.ts` expects the discounted amount for those periods, so they are no longer flagged.
- **An order paid another way** (a platform step shared with stage 35 and the till). A second
  door into "paid", beside the verified payment: a payment the **host** applies from value it
  holds (a voucher for a named thing, a money gift card, account credit) or that a **person**
  with a restricted permission records (a bank transfer, cash). Each is a payment row with its
  method; refunds go back the way the money came. ADR 0427 is amended once, for all of them.
- **Gifts, both kinds** (decision 2). A **gift voucher** for a named thing is sold like a pass: the
  paid line grants a voucher with a code; the person it is for redeems it, and the host makes the
  order for that thing paid by the voucher. A **gift card** is a money amount the host holds: spent
  on anything, in whole or in part, beside a card at checkout.
- **Referrals**: each member has a private invite link. A new friend gets the scheme's deal on
  their first purchase; the member's reward (chosen per scheme, decision 3) is given 14 days after
  the friend paid if nothing was refunded (decision 4). Suspicious pairs are held for staff.
- **Loyalty, later** (decisions 1 and 10): its spending goes through the gift voucher path, so it
  adds no new way to pay (step 11).
- **Reports** come from `rec_*` views over adjustments, uses, payments by method, vouchers, gift
  card balances and referrals.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **The provider's own promo codes on its checkout page** | The provider would decide the price and the host would learn it afterwards; limits, member prices, staff orders, deposits, drop-ins and the tax split would all be wrong or unenforceable. The host prices; the provider charges |
| **A discount as a sellable record with a negative price** (a "discount line") | Breaks the tax split (a negative share), refunds by line, "an order has nothing to pay" and every report that sums lines |
| **A pack hooking order pricing** | Not allowed: a new behaviour is platform work (ADR 0404) |
| **Discounts as core base records** (`core_offer`, fixed fields) | Simpler, but every business shapes discounts differently and the admin already renders pack objects; the behaviour keeps the rules in the host and the shape in the pack, as `sellable` does |
| **Stacking several deals** | The owner chose one deal, the better for the customer (decision 9) |
| **A voucher redemption as a full-cover adjustment** (the draft's first idea: total brought to nothing, the order "born paid" by an exception) | It hides what was sold (every report would show a free order), needs its own exception to "nothing to pay", and is a second, special-cased way of paying anyway. As a payment by the voucher, the order shows its real price, paid by stored value, and shares the one design with gift cards, transfers and cash |
| **A gift card as an adjustment** (money off) | A gift card is money the customer already paid; treating it as a discount would lower the taxable amount sent to the provider and show the business giving money away. It is a way of paying |
| **Gift cards kept at the provider** (its customer balance) | The provider's balance pays only the provider's own charges (subscriptions), not the host's orders or the desk; the host would not know the liability. The host keeps the ledger |
| **Each stage building its own "paid another way"** (35's recorded payment, the till's cash, this stage's vouchers) | Three doors into "paid" written three times, each a hole to review. One function, one payment row shape, one guard, one ADR |
| **Points as money** (a points balance spent at checkout) | Points would be a third kind of stored value as tender. Spending points through a voucher for a named thing keeps loyalty off the payment path (step 11) |
| **A code on a membership for every payment** | Decision 6: a discount for ever is a members' or customer rate the business can change later, not a code |

## Platform work and pack work

| Piece | Platform or pack | Notes |
| --- | --- | --- |
| `core_order_adjustment`, net line totals, total after adjustments, the pricing seam (`priceLines`), tax split and refunds owed on the net | **Platform** (orders, a migration) | Touches `orders.ts`, `tax.ts`, `refund-due.ts`, `checkout.ts`, `payments.ts`'s match, the `rec_order` views |
| `order.adjust` / `order.unadjust`, the staff limit setting, approval above it, `orders:discount` | **Platform** (operations, settings, approvals) | Grantable core permission, admin by default |
| Folding plus-addressed emails for one-per-Person rules (#225) | **Platform** (customers, `trial.ts`, `once.ts`, a migration) | Also fixes trials and intro offers |
| **An order paid another way** (shared): `method` on payments, the host's second door into paid, recorded payments by a person, stored value spent by the host, reversal, refunds by method, reports | **Platform** (orders, a migration; amends ADRs 0427, 0429 and 0479) | **Shared with stage 35 and the till**: built once by whichever is first |
| The `discount` behaviour: manifest key, contract checks, host pricing, codes, eligibility, limits | **Platform** (`packages/sdk`, new `core/src/discounts/`, a migration) | The heart of the stage |
| A discount on a subscription for 1 or N periods; expected amount per period; a one-period discount on a running subscription | **Platform** (`gatekeeper-payments`, `subscriptions/`) | The provider's coupon made by the gatekeeper, never typed by a buyer |
| A voucher grant and its redemption | **Platform** (grants, the shared payment step) plus pack | `sellable.grants` gains a voucher form |
| Gift cards: the stored value ledger, issue on a paid line, spend with a hold, part payment at checkout | **Platform** (core `storedvalue/`, a migration) | Money held for customers is the host's, not pack data |
| Referral attribution, the 14-day wait, the reward given by the host, the card fingerprint | **Platform** (`discounts/referrals.ts`, the minute cron, `gatekeeper-payments`) | |
| The Offers pack: discount, promo code, gift voucher type, voucher, gift card type, referral scheme, invite; tools, views, dashboard, routine mail, blocks, screens | **Pack** (`packs/offers`) | Composes the behaviours; no hooks on writes |
| Code fields and price lines in Ticketing, Memberships, Courses and Bookings blocks | **Pack** (each pack's blocks) | A shared hook in the Offers pack |
| Loyalty (later) | **Platform** for the earning ledger, **pack** for the scheme | Step 11, after its interview |

## The model

### Words (for `CONTEXT.md`)

- **Adjustment**: an amount taken off an order, on a line or spread over its lines, with its kind,
  its source (a discount or a person) and why. Avoid: coupon, rebate.
- **Offer** is already taken twice (a continuation offer; Rostering's offer of a shift). The pack
  is "Offers", but its records are **discounts**, **promo codes**, **gift vouchers**, **gift
  cards** and **referral schemes**; the word "offer" alone is not used for them.
- **Discount**: a record of a `discount` object: what is off (a percentage, an amount, or a set
  price), on what (objects, or named records), for whom, when, how often. Applied by a **promo
  code** or **automatically** (a **member price**, a customer rate).
- **Deal**: the one discount an order gets (decision 9). Staff adjustments are not deals.
- **Promo code**: a word a buyer types (`JANUARY`), shared, case-insensitive; or a batch of
  single-use codes (random and unguessable, like a grant's code).
- **Gift voucher**: what a paid line of a voucher type grants: a code for one named thing,
  redeemed once by the person it is for. Avoid: gift card for it.
- **Gift card**: a money amount the host holds for whoever has its code, spent on anything until
  it runs out or expires. Avoid: voucher, credit for it.
- **Account credit**: a money amount the host holds for one Person (a goodwill credit, or a
  refund given as credit), spent like a gift card but only by them.
- **Stored value**: a gift card or account credit: money the host holds for a customer. Not a
  member's tab (the till's "on account", money a customer owes).
- **Paid another way**: an order paid, in whole or part, by something other than the provider's
  verified payment: stored value or a voucher the host applies, or a payment a person records.
- **Referral**: a friend's first purchase made through a member's invite link; **qualified** when
  paid and not refunded for 14 days (decision 4); then the member's **reward** is given.
- **Folded address**: an address with its `+tag` removed and lower-cased, used only to decide
  "the same person" for one-per-Person rules.

### Records and states

Core tables (platform):
- `core_order_adjustment`: id, order, line (nullable), kind, source object and record (nullable),
  given by (principal, for `staff`), reason (text, for `staff`), amount (positive minor units),
  approval (the pending action, when it waited), created. Never updated; an adjustment removed
  from a pending order is a row marked removed.
- `core_order_line.line_discount` (migration): the line's share of the adjustments; the line's
  net is `line_total − line_discount`.
- `core_discount_use`: Person (or folded address), discount, order or subscription, state `held` /
  `used` / `released`, as `core_sellable_once`; a trigger keeps total and per-Person counts and
  refuses one over the limit.
- `core_order_payment` gains `method` (below, the shared step).
- `core_stored_value` and `core_stored_value_entry` (gift cards and account credit, below).
- `core_referral`: referrer Person, friend Person, scheme, order or subscription, state `pending` /
  `held` / `qualified` / `rewarded` / `void` (with why), `qualifies_at`, `card_match`.
- The order snapshot and `rec_order` gain `discount` (the sum); new `rec_order_adjustment` and
  `rec_order_payment` (with method).

Offers pack objects (declare `discount` or `sellable`):
- `offers.discount`: name, kind (percent / amount / set price), value, applies to (objects, or
  named records), who (anyone / signed-in / members of chosen plans / new customers / an
  organisation or tag), window (from, until), limits (total uses, uses per person, minimum spend),
  periods (for plans: 1 or N, decision 6), automatic or by code. States `draft` → `active` ↔
  `paused` → `ended`; moving to `active` is a person's move (an AI's request waits).
- `offers.code`: the word, or a generated single-use code; belongs to a discount. Live / used /
  void.
- `offers.vouchertype` (sellable): what it gives (a pass type, a plan's first N periods, a ticket
  type, a course), its price, how long a voucher is valid.
- `offers.voucher` (granted, with a code): the type, buyer, who it is for (name, address, a short
  message), send date, valid until. States `valid` → `redeemed` / `expired` / `void`.
- `offers.giftcardtype` (sellable, declares `storedValue`): a name, the amount it loads (a fixed
  amount per record: one record per amount offered), how long a card is valid.
- `offers.scheme` (referral scheme): the friend's discount, the member's reward (decision 3: money
  off their next membership payment, a pass type, or a voucher type), days to qualify (14,
  decision 4), most rewards per member per year, which plans or items count as joining. Draft /
  active / ended.
- `offers.invite`: a member's private link (a random token, its hash kept), scheme, live or ended.

### Operations

| Operation | Audiences | Who may | Risk | Notes |
| --- | --- | --- | --- | --- |
| `order.start`, `order.startHeld`, `subscription.start` gain `code` and `invite` | staff, customer, **public** (already open) | as today | write | Input widened on public operations: a reviewed change (ADR 0402). Rate limited per address and per connection |
| `order.applyCode` / `order.removeCode` | staff, **customer** (own order), **public** (with the order's token) | the order's buyer | write | Only on a pending order before its checkout opens. **Newly opened to customers and the public**: called out for review |
| `order.adjust` | staff | `orders:discount`, a person | write | Amount or percentage, line or order, reason required. Within the admin's limit: applied. Above it: waits for a person's approval. An AI's call always waits |
| `order.unadjust` | staff | `orders:discount` | write | Pending orders only |
| `order.settings.update` (the staff limit) | staff | human admin only | admin | Loosening the limit is human-admin-only |
| `discount.check` | staff, customer, public | anyone, rate limited | read | Whether a code applies to given lines and what it takes off. One answer, "not valid here", for unknown, ended, used up and not for you. Not offered to the assistant |
| `order.recordPayment` / `order.reversePayment` | staff | `orders:payments`, `actors: ["human"]` | write | The shared step: a payment taken another way, and undoing one entered in error |
| `order.applyStoredValue` / `order.removeStoredValue` | staff, **customer** (own order), **public** (with the order's token and the card's code) | the buyer; staff with `orders:payments`, a person | write | Puts a gift card or the buyer's own credit on a pending order. **Newly opened to customers and the public** |
| `giftCard.check` | customer, public | anyone holding the code, rate limited | read | The balance and expiry; the same "not valid" for unknown and used up |
| `voucher.redeem` | **customer** | the signed-in person whose address it was sent to, or anyone holding the code when the buyer marked it "anyone with the code" | write | Newly opened to customers. Makes the order paid by the voucher |
| `voucher.mine`, `giftCard.mine`, `credit.mine`, `invite.mine`, `reward.mine` | customer | own only | read | |
| `invite.create` / `invite.end` | customer (own), staff | the member; `offers:manage` | write | One live link per member per scheme |
| `referral.list`, `referral.release`, `referral.void` | staff | `offers:manage`; a person for release and void | write | Held pairs are released or voided by a person |
| `voucher.issue`, `voucher.void`, `voucher.extend`; `credit.give` | staff | `offers:vouchers` (restricted, ADR 0625), a person, with a reason | write | A comp voucher or a goodwill credit given by hand |

### Rules at pricing (the host's, in `priceLines`)

1. Lines are priced as today. Then every automatic discount the buyer qualifies for and the code,
   if given, are checked; the one that takes most off applies (decision 9). A staff adjustment is
   added after it.
2. "Who": a guest never qualifies for a members-only, per-person or new-customer discount (the
   same answer for every address, as for intro offers). Signed-in customers and staff buying for a
   Person do.
3. "New customer": no paid order, no subscription and no membership for any live Person with the
   same folded address.
4. A percentage is rounded down to the minor unit per line; an order-level amount is spread over
   eligible lines in proportion. A line never goes below nothing.
5. The total after adjustments must be at least the provider's minimum charge, or nothing only
   when a person's staff adjustment made it so. A code cannot make an order free; a staff
   adjustment can (within the limit or approved).
6. Deposits: the deposit stays what the records say; the discount comes off the balance. If the
   deposit would be the whole discounted total, the buyer pays in full.
7. Limits are held in the order's batch; of two orders at once at the last use, one gets it.
8. Delivery (stage 37) is priced after the deal. A delivery option's free postage over an amount
   still applies alongside a code or a members' price (decision 12): it is not the one deal. Its
   "free over" counts the goods lines' net, after the deal (stage 37 left this to this stage;
   decided by this spec, open to override).

### An order paid another way (the shared platform step, step 3)

**Shared with stage 35 (a recorded bank transfer, cheque or card machine) and the till (cash, and
later a member's tab). Built once, by whichever is built first, to this design; the others add
their own operations on top of it.** It amends ADR 0427 ("paid only by a verified payment"), ADR
0429 (refunds only through the provider) and ADR 0479 (tax on a part not paid through the
provider). Today there is exactly one door into `paid`; this adds exactly one more.

**The second door.** `applyOtherPayment(ctx, payment)` in `orders/payments.ts`, beside
`applyVerifiedPayment`: a function, not an operation, that writes a `core_order_payment` row and
moves the order as the host in the same batch, through the same settle path the verified payment
uses (paid or part paid, grants, holds confirmed, `sellable.moves`, one-per-Person and discount
uses spent, agreements due checked, stage 44). Only the named operations below call it, each
passing its own checked inputs; no operation passes its input through.

**The payment row.** `core_order_payment` gains `method`:
- `provider`: today's rows, the provider's verified payment (and the till's card reader, which is
  also provider-verified);
- `recorded`: a payment a person says they received, with `recorded_kind` (`transfer`, `cash`,
  `cheque`, `card_machine`, `other`), `recorded_by` (the person), `received_on`, `reference`;
- `voucher`: a gift voucher for a named thing, with the voucher;
- `stored_value`: a gift card or account credit, with its `core_stored_value` id.

Non-provider rows use provider `host` and an event id the host makes, so the primary key and
"applied once" hold. A trigger refuses a `recorded` row without `recorded_by`, and a `voucher` or
`stored_value` row without its matching ledger entry (a voucher moved to `redeemed`, a stored
value `spend`) in the same batch.

**Who may make each one.**
- **Recorded**: a person with the restricted core permission **`orders:payments`** (admin by
  default, granted one by one by a human admin, ADR 0449), through `order.recordPayment`, which is
  `actors: ["human"]`: never an assistant, an MCP client, an automation, an extension, an import or
  code. Stage 35's `invoice.recordPayment` and the till's `order.takeCash` are their own
  operations with their own extra rules (an issued invoice; an open till session) and their own
  permissions, also human only, calling the same function. Any amount up to what is owed;
  overpaying is refused.
- **Stored value**: spent only at the request of whoever it belongs to: the buyer applying a gift
  card's code or their own credit to their pending order (`order.applyStoredValue`), or staff with
  `orders:payments`, as a person, at the desk for them. An AI never spends stored value.
- **Voucher**: `voucher.redeem` by the person it is for, or staff with `offers:vouchers` as a
  person.

**Audited.** Every recorded payment and reversal (who, when, how much, the kind and reference),
every stored value issue, spend, release, refund back, expiry and void, every voucher redemption.
A recorded payment over a threshold a human admin sets tells the admins. Each is posted on the
Person's timeline.

**Reversal.** `order.reversePayment { paymentId, reason }`: `orders:payments`, human only, for a
recorded payment entered in error. A second row that undoes the first; nothing is edited or
deleted; the order moves back as the host if it is no longer paid. Refused for a provider payment
(that is a refund) and for stored value or a voucher (that is a refund back to it).

**Refunds go back the way the money came** (amends ADR 0429). `order.refund` still asks, and a
person with `orders:refund` still approves (never an AI). What may go back is still what was paid,
now per payment row:
- `provider`: through the gatekeeper, as today;
- `stored_value`: back onto the same gift card or credit (a fresh one if it has expired), by the
  host in the approval's batch, no provider;
- `voucher`: the voucher back to `valid` if not expired, else a fresh voucher issued;
- `recorded`: recorded as paid back by the person (how: `transfer`, `cash` from an open till, and
  so on), never sent by the host.

A partial refund of an order paid two ways goes back to the provider payment first, then to the
stored value (decision 13: the customer gets money before credit). The person asking for the
refund may split it otherwise (an amount per payment, each at most what that payment paid); the
approver sees the split.

**Reports.** `rec_order_payment` with its method and kind: money taken (provider plus recorded),
value redeemed (vouchers and stored value, which is not new money), and refunds by method. The
gift card and credit liability (balances outstanding) is `rec_stored_value`. What these mean for
the books is for the business to confirm with its accountant.

**Part payment by gift card and card at checkout: what it needs.**
1. The buyer puts the gift card on their pending order (`order.applyStoredValue`, by code; rate
   limited). The host **holds** `G = min(balance, total)` on the card (a `hold` entry: the card's
   available balance drops; on `once.ts`'s shape: spent when the order is paid, released when the
   unpaid order expires or is cancelled).
2. If `G` covers the total, the host applies it at once in the batch: the order is paid with no
   checkout. Otherwise the rest, `total − G`, must be at least the provider's minimum charge;
   if not, the host holds less of the card so that it is.
3. `chargeFor` and the checkout ask the provider for `total − G` only; the amount-match rule
   (ADR 0427) compares the verified payment against `total − G`.
4. **Tax.** The card part is split over the net lines in proportion (`splitInProportion`) and
   each share is sent with its tax code, as today, so the provider taxes what it charges. The gift
   card part is not charged by the provider, and the host never calculates tax: each gift card
   type says whether the business treats it as taxed **at sale** (the card's own order is taxed by
   the provider when it is bought, and its spending carries no tax) or **at redemption** (the
   gatekeeper asks the provider for a tax calculation of the gift card part, with no charge, and the
   host stores what it says). Which is right is for the business to confirm with its accountant;
   until a human admin chooses, gift cards cannot be sold.
5. When the verified payment arrives, in **one batch**: the provider row is applied, the card's
   hold becomes a `spend` and a `stored_value` payment row, and the order is paid. If the order had
   expired first (the hold released), the payment is paid late as today (ADR 0429): staff honour it
   (the host re-holds the card if its balance allows, else staff refund) or refund it.
6. Deposits: a gift card pays only full-pay orders in this stage (decided by this spec, open to
   override). A subscription's periods are charged by the provider and cannot be paid by a gift
   card.
7. Refunds: as above, per payment row, provider first.

### Gift vouchers for a named thing

- Bought on the website by anyone (a guest may: it is not one per person), with who it is for, a
  short message and a send date. The paid line grants the voucher and its code; the email to the
  recipient is routine mail on the send date; the buyer gets their own copy.
- Redeemed by the recipient signed in (their address proved by its code, ADR 0458). The host
  makes an order for the named item at its price and pays it with a `voucher` payment in the same
  batch (the shared step): grants, holds, agreements due (stage 44) and the item's moves run as for
  any paid order. A voucher for a plan's first N periods starts the subscription with that many
  periods free (a free-until date, as continuation offers do) and the card taken for after.
- Refunded only while not redeemed: the refund voids the voucher (the grant's void path).
- Tax: the voucher's sale is taxed at its item's tax code by default; its redemption is not a
  provider payment. A human admin may mark a voucher type untaxed at sale. Which is right is for
  the business to confirm with its accountant.

### Gift cards and account credit (stored value)

- `core_stored_value`: id, kind (`gift_card` | `credit`), Person (for credit; for a gift card the
  buyer and, when given, the recipient), code hash (a gift card's code is shown once to the buyer
  and in the recipient's email, never stored in clear), currency, expires at, state (`live` /
  `spent` / `expired` / `void`). `core_stored_value_entry`: append-only `issue`, `hold`,
  `release`, `spend`, `refund_back`, `expire`, `void`, with amounts; a trigger keeps the balance
  and refuses it below nothing.
- A gift card is issued by the paid line of a gift card type (`sellable.storedValue`), emailed as a
  gift voucher is. Refunded only while nothing has been spent from it.
- Account credit is given by a person (`credit.give`, with a reason) or by a refund the approver
  chose to give as credit. It is spent only by its Person.
- Expiry: a setting per gift card type, with no default from the platform. What a business may set
  is for it to confirm with its lawyer. Balances left at expiry are reported.

### Subscriptions

- A code whose discount has `periods` set (1 or N, decision 6) asks the gatekeeper to attach a
  discount for that many periods when it opens the subscription page. The gatekeeper's new request
  field carries the amount or percentage and the periods; the provider's coupon is made by the
  gatekeeper, named by the host's discount id, never typed by a buyer at the provider.
- Each paid period's order records a `code` adjustment of what the provider took off, and
  `periodFlag` compares against the discounted amount while the discount runs.
- With a trial, the discount starts at the first paid period. A continuation offer and a code do
  not combine (the continuation is already free time).
- A plan change keeps the discount for its remaining periods, as the provider does: a percentage
  on the new price, an amount as it was.
- Members' prices apply to one-off purchases (drop-ins, tickets, courses, passes), not to plans: a
  lower plan price is its own plan (decided by this spec, open to override).
- A referral reward of "money off the next payment" is the host's call to put a one-period
  discount on the member's running subscription (a new gatekeeper action that only lowers a
  charge).

### Referrals

- The invite link opens the business's page with the friend's deal; it does not show the member's
  name. The friend's first purchase carries the invite; the host checks "new customer" and that
  the friend is not the member (Person, folded address, family link).
- The provider reports a card fingerprint on verified payments (hashed with a per-deployment key,
  kept only for this check). The same card as the member's, or the same folded address: the
  referral is `held` for staff (decision 4).
- At `qualifies_at` (paid, plus 14 days, not refunded; for a deposit, paid in full) the minute cron
  gives the reward in one batch, and the member is emailed: money off their next payment, a pass
  of the scheme's type, or a voucher of the scheme's type (decision 3). A friend refunded before
  then voids it. Rewards per member per year are capped by the scheme.

### Staff discounts at the desk

- `order.adjust` on a pending order (online or, with the till, at the desk), by a person with
  `orders:discount` (grantable, admin by default: the owner grants it to desk staff), with a reason
  from a short list the business keeps or typed.
- The limit (a percentage and an amount per order) is a setting only a human admin changes.
  Within it: applied at once. Above it: an approval in the Approvals inbox, approved by a human
  admin (decision 5: "waiting for your approval"; ADR 0552's pattern, a person approves); the
  order waits, and its checkout cannot open until it is decided.
- An assistant's `order.adjust` always waits, whatever the amount.

### Refunds

- What can be refunded stays what was paid, per payment row. A refund owed for a line uses its net
  paid share.
- A refund keeps a discount use used (as for intro offers); staff may give one back with a reason.
- A qualified referral's reward stays when the friend is refunded later; staff are told.

### Tax

The host sends the provider each line's net amount with its tax code, so the provider taxes what
is charged. Gift vouchers and gift cards are as above. Whether a discount reduces the taxable
amount, and how vouchers and gift cards are taxed, is for the business to confirm with its
accountant. The host never calculates tax.

### Screens

- **Web admin** (stage 47 screens of the Offers pack): Discounts (list, edit, activate), a
  discount's codes and uses, Gift vouchers and gift cards (sold, redeemed, outstanding), Referrals
  (pending, held, rewarded), and the Offers dashboard. On an order's page: its adjustments, its
  payments by method, "Give a discount" for `orders:discount`, "Record a payment" for
  `orders:payments`.
- **Customer web** (blocks): a code field, a gift card field and the discounted lines on the buy,
  drop-in and subscribe blocks of Ticketing, Memberships, Courses and Bookings (one shared hook);
  buy a gift; redeem a voucher; check a gift card; invite a friend (copy link); my vouchers, gift
  cards, credit and rewards.
- **Native**: invite a friend (the phone's share sheet), my vouchers, gift cards and rewards,
  redeem by code. Buying stays on the website's checkout. Same hooks, own screens.

### Notifications (routine mail unless said)

The recipient's gift on its send date and the buyer's copy; a voucher's or gift card's reminder
before it expires; the member's "your friend joined, here is your reward"; staff told of a held
referral, a code reaching its use limit, a staff discount waiting for approval (Approvals inbox),
and a recorded payment over the threshold (admins).

### What an AI may do

- Read discounts, uses and reports; draft a discount or a scheme (state `draft`).
- Never activate a discount, loosen a limit, give a staff discount, record or reverse a payment,
  spend stored value, give credit, or redeem, void or issue a voucher without a person;
  `order.adjust` from an AI always waits; `order.recordPayment` is not open to it at all.
- Never read unredeemed voucher codes, gift card codes, single-use codes or invite tokens.
- `discount.check` and `giftCard.check` are not offered to the assistant.

### Privacy and erase

- A member sees how many friends joined and their own rewards, never the friends' names. A friend
  never learns who invited them beyond what the member told them.
- Staff with `offers:manage` see referral pairs; held pairs show why (same card, same address).
- Erase: a Person's adjustments and payments keep their amounts, kinds and sources (the order is a
  financial record) with staff reasons blanked; their referrals keep the other side's reward with
  them removed; their invite link ends; their unredeemed vouchers are voided; their account credit
  is voided and reported; a gift card they bought stays valid for its holder; their card
  fingerprint and folded-address rows go. How long financial records are kept is for the business
  to confirm with its accountant.

### Loyalty (step 11, later)

In scope (decision 1), not in the first build (decision 10). The shape this spec proposes, to be
settled at its interview: a loyalty scheme counts what a Person did (paid classes attended, or
net money spent) in a host ledger written from paid orders and attendance, and a reward (a voucher
of a chosen type) is given when a count is reached, or bought with points. Either way loyalty
spends through gift vouchers, never as a payment, so it needs no change to the shared step.

## Out of scope

- More than one deal on an order; "buy two, get one"; bundles that are not already a record.
- Codes for every payment of a membership (decision 6).
- A gift card paying a deposit or a subscription's period.
- A member's tab ("on account", money owed): the till's later step, on its own ledger.
- Importing a previous system's outstanding gift vouchers, gift card balances and codes (a
  `cos offers import` could follow, with stage 33).
- Changing a trial's length by code.

## Acceptance criteria

1. An order with a percentage code: each line's net, the order's total and the amount the provider
   is asked for all equal the discounted prices; the adjustment names the discount.
2. With tax at checkout on, the provider's shares are the net line amounts and sum to the charge.
3. A code given by a caller who is not eligible (a guest on a members-only code, a used-up code,
   an ended one, an unknown one) gets the same answer; 20 wrong tries from one connection are
   slowed.
4. A code with one use left: two orders started at once, one gets it.
5. A use held by an unpaid order is released when it expires; a paid order's use stays after a
   full refund.
6. `a+1@x` and `a+2@x` count as one person for per-person codes, new-customer checks, trials,
   intro offers and referrals (#225); `a.b@x` and `ab@x` stay two.
7. A member's automatic price applies to a drop-in and an event ticket for a signed-in member and
   not for a guest using their address. With a code that takes more off, the code applies instead;
   with one that takes less, the member's price does.
8. Staff with `orders:discount` give 10% with a reason within the limit; 50% over the limit waits
   in Approvals; an assistant's request always waits; a member without the permission is refused.
9. A deposit order with a discount keeps its deposit and lowers its balance.
10. A code for 3 periods on a membership plan: the first three paid periods' orders carry the
    adjustment and are not flagged; the fourth is charged in full (fake provider; a test-mode
    provider run noted). A discount set for every period is refused by the contract check.
11. A plan change during a discount keeps it for the remaining periods.
12. A gift voucher for a pass, bought by a guest, is emailed on its send date; the recipient signed
    in redeems it and holds the pass; the order shows the pass's price paid by the voucher, with no
    provider payment; a second redeem is refused.
13. A voucher refunded before redemption is void; after redemption, a refund puts it back to
    valid, approved by a person with `orders:refund`.
14. A gift card covering part of an order: the card's balance is held, the provider is asked for
    the rest only, the verified payment makes the order paid with two payment rows in one batch,
    and the card's balance is lower; an order that expires gives the hold back.
15. A gift card covering a whole order makes it paid with no checkout; a rest below the provider's
    minimum is avoided by holding less of the card.
16. A refund of an order paid by gift card and card goes to the card first, then back onto the gift
    card, each approved by a person; the gift card's balance shows it.
17. `order.recordPayment` by a person with `orders:payments` makes an order paid with a `recorded`
    row naming them; it is refused for an admin's assistant, an MCP client, an automation and a
    member without the permission; a reversal by a person moves the order back; nothing a caller
    sends can make a `voucher` or `stored_value` row without its ledger entry (the trigger refuses
    it).
18. A friend through an invite link gets the scheme's deal on their first purchase; the member's
    reward is given 14 days after, once; a refund before then voids it.
19. A friend with the member's folded address, or the same card, is held for staff and rewards
    nothing until released.
20. Activating a discount from the assistant waits for a person; an AI reading vouchers or gift
    cards sees no codes.
21. Erasing a Person keeps adjustment and payment amounts and blanks reasons; their vouchers and
    credit are void and their invite link ends.
22. The Offers dashboard shows discount given, orders and revenue per discount, payments by method,
    vouchers and gift card balances outstanding, and referrals by state, from `rec_*` views only.
23. A refund owed for a discounted drop-in returns the net amount paid.
24. A runtime extension may declare `discount` objects and pass `cos ext check`; it cannot reach an
    order's pricing except through the behaviour.
25. E2E, one per journey: buy with a code; a member's price; a desk discount over the limit
    approved; buy and redeem a gift voucher; pay part by gift card; an invite to a reward.
26. The site and `SITE.md` list promo codes, member prices, gift vouchers and gift cards, and
    referrals when they ship.

## Dependencies

Built: stage 25 (orders, refunds), 27 (sellable, grants), 31a (drop-ins), 32a and 32b
(subscriptions, passes, one per Person, plan changes), 42 (tax at checkout), 44 (agreements due at
purchase, which a redeemed voucher must respect). Spec agreed, not built: stage 47 (pack screens:
the staff screens need it; until then the generic record pages work) and stage
[37](37-shop.md) (shop: the pricing seam `priceLines`, its delivery option's free postage over an
amount, line refunds on the net). Drafted, not specced: 35 (invoices and quotes: recorded payments
and credit notes on the shared step, adjustments on quotes), the point of sale module (cash on the shared step, desk discounts by `order.adjust`), 33 (importing
vouchers and codes). Issues #102, #125, #225.

## Migrations and numbers

Block **BD** in [`parallel-work.md`](../parallel-work.md): migrations 0950 to 0969, ADRs 0690 to
0699. The ADRs the build will need:

| ADR | Decision | Amends |
| --- | --- | --- |
| 0690 | Adjustments on orders: net lines, the total after adjustments, the pricing seam (built in step 1) | 0427, 0479 |
| 0691 | Staff discounts: `orders:discount`, the limit, approval above it (built in step 1) | 0449 |
| 0692 | One person per folded address (#225) | 0489, 0512 |
| 0693 | The `discount` behaviour: codes, automatic prices, one deal per order, limits held by the database (was 0691: step 1 took 0690 and 0691) | 0435 |
| 0694 | **An order paid another way**: the second door, payment methods, who may make each, reversal, refunds by method, reports (shared: if stage 35 or the till builds the step first, it writes this ADR in its own block and 0694 stays free) | 0427, 0429, 0479 |
| 0695 | Discounts on subscriptions for 1 or N periods, and a one-period reward | 0486, 0530 |
| 0696 | Gift vouchers and gift cards: stored value held by the host, part payment at checkout | 0435 |
| 0697 | Referrals: attribution, the 14-day wait, the card fingerprint, held pairs | |
| 0698 | Loyalty (step 11, after its interview) | |

Migrations, one or more per step, from 0950. If a step needs a `core_write_guard` kind, it
follows the ordering rule in `parallel-work.md` (carry every earlier kind, sort after 0851).

## Suggested build order

| Step | What | Files and areas | Can be built beside |
| --- | --- | --- | --- |
| 1 | **Adjustments**: table, net lines, total, the pricing seam `priceLines`, tax split and refunds owed on the net, the order's views; `order.adjust` / `unadjust`, the limit, approval, `orders:discount` | `orders/` (`orders.ts`, `tax.ts`, `refund-due.ts`, `checkout.ts`, `payments.ts`), `operations/order.ts`, `principals.ts`, a migration, `rec_order` views | Step 2 and anything not in `orders/`. **Collides** with stage 35, stage 37 (delivery, returns), the till, stage 44 step 7 (cooling off, PR #299) and any branch in `orders/` or `operations/order.ts`. Must land alone first and be reviewed: every later step reads net lines |
| 2 | **Folding plus addresses** (#225) for trials, intro offers and the new uses | `customers/accounts.ts`, `subscriptions/trial.ts`, `orders/once.ts`, a migration | Steps 1 and 5. **Collides** with branches in `subscriptions/` and `customers/` |
| 3 | **An order paid another way** (shared): `method` on payments, `applyOtherPayment`, `order.recordPayment` / `reversePayment`, `orders:payments`, refunds by method, the guard trigger, `rec_order_payment` | `orders/payments.ts`, `orders/refunds.ts`, `operations/order.ts`, `principals.ts`, a migration | After 1 (same files). **Collides** with stage 35 step 4 and the till's step 2, which build the same thing: whichever starts first owns it, and the others wait for it to merge |
| 4 | **The `discount` behaviour**: manifest key and contract checks, codes and automatic discounts in `priceLines`, limits (`core_discount_use`), `discount.check`, `order.applyCode`, rate limits | `packages/sdk` (manifest, contract), new `core/src/discounts/`, `orders/orders.ts` (`priceLines`), operations, a migration | After 1. Beside 3 (different files except `operations/order.ts`: keep both sides) and 5 |
| 5 | **The Offers pack's spine**: discount, promo code, member price and customer rate, tools, views, settings, permissions | `packs/offers`, `packages/core/src/pack-roles.ts` | After 1 for tests; beside 2 to 4. **Collides** on `pack-roles.ts` |
| 6 | **Subscriptions**: a discount for 1 or N periods, the expected amount, plan changes, a one-period discount on a running subscription | `packages/gatekeeper-payments` (types, the provider, the fake), `subscriptions/` (`subscriptions.ts`, `periods.ts`, `changes.ts`) | After 4. Beside 7 and 8. **Collides** with any `subscriptions/` or gatekeeper-payments branch |
| 7 | **Gift vouchers for a named thing**: the voucher grant, `voucher.redeem` paid by the voucher, refunds put it back or void it | `orders/grants.ts`, `orders/payments.ts` (through step 3), `packs/offers` | After 3 and 4. Beside 6 |
| 8 | **Gift cards and account credit**: the stored value ledger, issue on a paid line, `order.applyStoredValue`, the hold, part payment at checkout, the tax choice per type, refunds back onto the card | new `core/src/storedvalue/`, `orders/checkout.ts`, `orders/payments.ts`, `orders/tax.ts`, gatekeeper-payments (a tax calculation with no charge), a migration, `packs/offers` | After 3 and 7. **Collides** with any `orders/` or gatekeeper-payments branch, and step 6 on the gatekeeper |
| 9 | **Referrals**: invites, attribution, the card fingerprint from the gatekeeper, the 14-day wait on the minute cron, rewards, held pairs | `core/src/discounts/referrals.ts`, gatekeeper-payments (fingerprint), the cron, `packs/offers` | After 4 and 7 (vouchers and passes as rewards); after 6 for money-off-next-payment rewards |
| 10 | **Blocks and screens**: the code and gift card fields and price lines in each pack's buy blocks, gift and invite blocks, native screens, stage 47 screens, the dashboard, routine mail, e2e per journey, the site and `SITE.md`; free postage over an amount once stage 37's delivery is built | `packs/*/blocks`, `packs/offers/blocks` and `client`, `apps/app/e2e`, `apps/marketing` | Blocks per pack in parallel once 4 lands; stage 47 screens after 47 merges. **Collides** with any branch editing those packs' blocks |
| 11 | **Loyalty**, after its interview | `core/src/discounts/` (the earning ledger), `packs/offers` | After 7 |

**What can start first:** steps 1 and 2 together. Step 1 collides with everything in `orders/`
(stage 35, 37, the till, PR #299); step 2 with `subscriptions/` and `customers/`. Then 3, 4 and 5
together, then 6 and 7, then 8 and 9, then 10.

## Decided by this spec, open to override

- An adjustment is a core table on orders, not a negative-priced line.
- One pricing seam, `priceLines`, used by `createOrder` and the shop's `order.quote`.
- Discounts are declared by a pack through a new `discount` behaviour, not core base records.
- A code cannot make an order free; a person's staff adjustment can.
- A guest never gets members-only, per-person or new-customer discounts.
- A refund keeps a discount use used.
- Deposits stay as the records say; the discount comes off the balance.
- A voucher redemption is a payment by the voucher, not money off: the order shows its real price.
- A gift card is a way of paying, held by the host, never a discount and never the provider's
  balance.
- A gift card pays full-pay orders only, not deposits or subscription periods.
- Gift cards cannot be sold until a human admin chooses "taxed at sale" or "at redemption".
- A voucher's sale is taxed at its item's code by default.
- Members' prices apply to one-off purchases, not to plans.
- Free postage's "free over" counts the goods' net, after the deal.
- A plan change keeps a running subscription discount.
- The invite page does not show the member's name; members do not see friends' names.
- Folding `+tags` applies to every domain; dots are not folded.
- `orders:discount` and `orders:payments` are core permissions, admin by default, granted one by
  one; recording a payment is human only.
- Loyalty spends through gift vouchers, never as a payment.

## Questions for the owner

One question, the interview step 11 (loyalty) waits for. Nothing else in the build waits on it.

1. **What should loyalty be?** Options: a reward after a number of classes or visits (every 10th
   class free); points for money spent, exchanged for a reward the business chooses; both.
   Recommended: a reward after a number of classes, given as a voucher, because it is what members
   understand and it stays off the payment path.

Questions 2 to 4 of the first version of this spec (gift card amounts, free postage alongside a
deal, where a partial refund goes first) were decided by the coordinator: decisions 11 to 13.

## For the business to confirm with its accountant or lawyer

- Whether a discount reduces the taxable amount, and whether a gift voucher and a gift card are
  taxed at sale or when spent.
- How long a gift card or voucher may be valid for, and what happens to a balance at expiry.
- How gift card and credit balances are shown in the books, and how long financial records are
  kept.

## Risks

- **Money**: a wrong rounding or spread makes the charge not match the order; every amount is
  integer minor units with the spread tested to sum. A second door into paid must be impossible
  to reach without a person's recorded payment, a redeemed voucher or a stored value spend: test
  every actor against it.
- **Abuse**: public code and gift card guessing (rate limits, one answer for every reason); plus
  addresses and new addresses for referrals (folding catches the first, a card fingerprint some of
  the second; neither catches a different card and a different address: caps per member limit the
  cost).
- **Privacy**: who invited whom is personal; card fingerprints are kept hashed and only for this.
- **Provider**: coupons for N periods, coupons added to a running subscription, the card
  fingerprint and a tax calculation with no charge need a real provider test-mode account to
  verify; the fake provider models them first. The test-mode runbook
  (`docs/subscriptions-stripe-runbook.md`) has not been run yet.
- **Collisions**: step 1 rewrites order pricing every selling pack relies on, and step 3 is shared
  with two other stages: both need the full order test suite and a review before anything builds
  on them.
