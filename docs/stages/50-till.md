# Stage 50: Till (point of sale at the desk)

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Orders and
payments, Behaviours, Packs and blocks), [`CONTEXT.md`](../../CONTEXT.md) (Order, Sellable,
Capacity, Claim, Hold, Checkout, Refund, Guest, Pack role, Permission grant, Routine mail, Desk
signing session), ADRs
[0427](../adr/0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md) (orders
paid only by a verified payment), [0428](../adr/0428-buying-without-an-account.md) (buying without
an account), [0429](../adr/0429-payments-gatekeeper-verified-events-and-refunds.md) (the payments
gatekeeper and refunds), [0430](../adr/0430-capacity-is-refused-by-the-database.md) to
[0432](../adr/0432-holds-have-no-clock.md) (capacity and holds),
[0435](../adr/0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md) (sellable),
[0449](../adr/0449-permissions-granted-one-by-one.md) (permissions granted one by one),
[0479](../adr/0479-tax-at-checkout.md) (tax at checkout),
[0487](../adr/0487-the-payer-and-the-holder.md) (payer and holder),
[0506](../adr/0506-a-spender-paid-another-way.md) (a spender paid another way),
[0552](../adr/0552-a-tool-a-person-approves.md) (a tool a person approves),
[0560](../adr/0560-a-paid-line-moves-a-record-that-exists.md) (a paid line moves a record),
[0590](../adr/0590-routine-mail.md) (routine mail),
[0600](../adr/0600-a-pack-role-and-its-grants-add-up.md) (grants add up),
[0625](../adr/0625-restricted-pack-permissions.md) (restricted pack permissions); stages
[25](25-states-orders-payments.md), [31](31-bookings.md), [32](32-memberships.md),
[34](34-offers.md) (**the pricing seam `priceLines` and the shared step "an order paid another
way", ADR 0694: this stage uses both and redefines neither**), [37](37-shop.md) (**`stock`,
`sellable.goods.soldIn` and [the seam with the till](37-shop.md#the-seam-with-the-till): this
stage keeps the till's side of it**), [44](44-agreements.md) (agreements at purchase, signing at
the desk) and [47](47-pack-screens.md) (pack screens); stage 48, My account (PR
[#311](https://github.com/timoconnellaus/composable-os/pull/311)); stage 51, Kiosk check-in
(specced separately: it defines the enrolled shared device); issues
[#126](https://github.com/timoconnellaus/composable-os/issues/126) (payments taken in person, left
out of stage 25 on purpose) and [#236](https://github.com/timoconnellaus/composable-os/issues/236)
(scanning a member's code at the desk); `packages/core/src/orders/` (`orders.ts`, `payments.ts`,
`refunds.ts`, `checkout.ts`, `events.ts`, `gateway.ts`, `moves.ts`, `tax.ts`, `settings.ts`),
`packages/core/src/operations/order.ts`, `packages/gatekeeper-payments/src/` (`provider.ts`,
`stripe.ts`, `fake.ts`, `events.ts`), `packs/bookings/tools.ts` (`bookFor`).

Status: **spec agreed** (owner interviewed 2026-11-24: decision 1 is the owner's; decisions 2 to
10 were decided as best practice and are the owner's to override). Build may start once its
first dependencies are in (below). No question blocks the design.

Vocabulary: a **till** is a named place money is taken (the front desk's drawer); a **till
session** is one person's shift on it, opened with a counted float and closed with a count (the
**cash-up**). A **tab** is money a member owes the business for things bought at the desk, paid
off later. "Product" is the platform's word for a composition (ADR 0400) and is not used for what
a business sells: the Shop's word is **item** and **variant**.

## Goal

Staff sell in person at the front desk, on a tablet in the product's admin: a drink, a shirt, a
class pack, a drop-in, a membership. The buyer is a member (the order is on their record) or a
walk-in (no record, or just an email address for a receipt). They pay by card on a card reader
connected to the business's own payment provider account, in cash, or on their tab, paid off later
at the desk or from an emailed link. A receipt goes by email. Refunds go back the way the money
came, approved as every refund is. At the end of the day the person closing counts the till, the
host shows what should be there, and a difference is recorded and, over a threshold, the owner is
told. Every sale is an ordinary order, so stock, passes, bookings, offers and reports see it as
they see a web sale.

## Who it is for

- **Gyms and studios first.** One front desk, one tablet, one card reader; a cash drawer with a
  float; drinks, supplements and clothing from the Shop's catalogue and stock; class packs, intro
  offers and drop-ins (Memberships and Bookings); memberships started in person; members who run a
  tab for drinks; a coach who also works the desk; an owner who checks the cash-up.
- **Later, a shared tablet at the fridge**, where a member serves themselves and pays on a reader
  (Shop follow-up answer 4: phones first, the tablet with this stage's reader after). Designed here,
  built as a later step on stage 51's enrolled device.
- **Trades and services** (next) need the same money paths and less of the till: a technician
  takes a card on a phone and reader at the customer's site, against a job or an invoice; cash is
  held by the technician, so a till is per person; trade customers buy on account through
  invoices (stage 35), not a tab. This stage designs the till per person and leaves the phone
  screen and the job-and-invoice side to later steps and stages 35 and 39.

## What exists today (from the code, checked 2026-11-24)

- **Orders** (`packages/core/src/orders/`, `operations/order.ts`): an order's lines are records of
  objects that declare `sellable`, priced by the host (`priceLines` in `orders/orders.ts`); money
  is integer minor units in one currency per deployment (`orders/settings.ts`). `order.start`
  requires an email address for everyone but a signed-in customer ("An order needs the buyer's
  email address"). `placedAs` is `customer`, `public` or `staff` (`fields/order.ts`). The states
  `pending`, `part_paid`, `paid`, `cancelled`, `expired`, `refunded` are fixed in core.
- **Drop-ins are their own order.** A record bought by `sellable.moves` is made with its order by
  `order.startHeld` (a pack's tool) and is refused on an ordinary order (`orders/orders.ts`).
- **The only door into paid** is `applyVerifiedPayment` (`orders/payments.ts`), from a provider
  event the gatekeeper verified (`orders/events.ts`); `core_order_payment` (migration 0422) is
  keyed by provider and event id. Stage 34's shared step (agreed, not built) adds the second door,
  `applyOtherPayment`, and a `method` on every payment row.
- **The payments gatekeeper** (`packages/gatekeeper-payments`): one `PaymentProvider` interface
  (`src/provider.ts`): `createCheckout`, `getPayment`, `refund`, and the subscription methods;
  Stripe and a fake. There is **no in-person payment**.
- **Grants, holds and moves** settle in the paid batch (`orders/grants.ts`, `orders/holds.ts`,
  `orders/moves.ts`). Stage 37's `stock` (agreed, not built) holds goods on start and writes `sold`
  when paid, through the same order hook.
- **Refunds** (`orders/refunds.ts`) go only to provider payments, asked by `order.refund` and
  approved by a person with `orders:refund` (`principals.ts`). Stage 34 amends them per payment
  method.
- **"Paid at the desk" in Bookings records no money.** `bookFor { paidAtDesk }`
  (`packs/bookings/tools.ts`) marks the booking `paidOtherwise` so it spends no use (ADR 0506);
  nothing records how much was taken, by whom or how.
- **Staff starting a membership** use `subscription.start` with the payer's email: the provider's
  hosted page takes the card.
- **Agreements at purchase** (stage 44): `order.start` and `subscription.start` refuse with
  `agreements_due`; staff send a link, sign at the desk or record paper.
- **Permissions**: pack permissions, roles and grants (`pack-roles.ts`, ADR 0600); restricted pack
  permissions (ADR 0625); `bookings:desk` is held by staff and granted to a coach.
- **Screens**: stage 47 (agreed, being built) lets a shipped pack declare staff screens in the
  admin.

## Decided at the interview (2026-11-24)

| # | Decision |
| --- | --- |
| 1 | **Members can run a tab at the desk.** They pay it off **at the desk or from an emailed link, when they choose**. It is **not** added to their membership payment (the owner's answer) |
| 2 | **Staff take cash at the desk, into a till** opened with a float and **counted when it is closed** each day |
| 3 | **Refunds: only people the owner chooses** give them; anyone else asks, and one of those people approves it later |
| 4 | **A membership started at the desk**: the member gives their card on the payment page on the desk tablet, **or** is emailed a link to finish on their own phone. **Staff choose each time** |
| 5 | **A walk-in can buy something small** (a drink) **without giving a name or email address** |
| 6 | **Receipts are always emailed to members**; to walk-ins only if they give an address |
| 7 | **The owner is told straight away of a cash difference of 10 or more** (whole units of the currency, over or under). Smaller differences go in the daily summary |
| 8 | **One card reader at one front desk** first. Several desks and a phone away from the desk are designed, built later |
| 9 | **One list of things and one stock count** with the online shop; **each item is marked for the desk, the website or both** (the Shop's `sellable.goods.soldIn`, stage 37 decision 3) |
| 10 | How the gym takes money today was not asked: the draft's assumptions stand (drinks, clothing, passes, drop-ins and memberships; card and cash; a count at closing), to be checked with the business during setup |

Decisions 2 to 10 were decided as best practice without asking (the owner's standing rule) and are
open to the owner's override.

## The design in one page

- **A desk sale is an order.** Staff start a desk order (`placedAs: "desk"`) for a Person, an
  email address, or nobody. It is **in person** by the Shop's channel rule: its goods lines must be
  sold in person (`sellable.goods.soldIn` of `in_person` or `both`), it needs no delivery line, and
  stock is held and sold through `stock` as for any order. Passes and other records that are not
  goods are sold at the desk unless their object says otherwise. The host prices it through
  `priceLines`, with stage 34's members' prices, codes and staff discounts (`order.adjust`) when
  built. **Nothing typed at the till is a price.**
- **Who the buyer is.** Goods alone may be sold to nobody (decision 5). A line that grants or moves
  a record (a pass, a drop-in) needs its holder: a Person, or for a drop-in a guest's name and
  email as online. A drop-in is its own order, made with its booking by Bookings' tool, as online.
- **Three ways to pay, each the host's.**
  - **Card on a reader.** The host asks the gatekeeper to put the order's amount on a named reader;
    the buyer taps or inserts their card; the provider's webhook reports the payment, the
    gatekeeper verifies it, and `applyVerifiedPayment` makes the order paid with a `provider` row,
    exactly as a web payment. Card details never reach the tablet, the host or the gatekeeper.
  - **Cash.** A person records that they took it, into the till session they have open:
    `order.takeCash`, human only, calling stage 34's `applyOtherPayment` with a `recorded` row of
    kind `cash` and the session. It is the till's own operation on the shared step (ADR 0694), as
    stage 34 names it.
  - **On the tab** (decision 1). The order is paid from the member's tab, which then owes the
    amount, up to a limit. A payment row of method `account` beside the tab's `charge` entry, in one
    batch, on the shared step. Nothing charges a stored card.
- **A till session holds the cash.** A person opens a till with a counted float. Every desk sale,
  cash payment and cash refund belongs to one open session. Closing it is the cash-up: the person
  counts, the host shows the expected cash and the session's card and tab totals beside it, and
  records the difference.
- **The tab is paid off when the member chooses** (decision 1): at the desk by card or cash, or
  from an emailed link on the provider's hosted page. Paying is an ordinary order with one host-made
  line, "Tab payment", priced by the host from what the member says they will pay, at most the
  balance.
- **Refunds go back the way the money came** (stage 34's rule): a card to the card through the
  provider; cash in cash from an open till; a tab payment back onto the tab. Every refund is asked
  with `order.refund` and approved by a person with `orders:refund` (decision 3). A person who holds
  it asks and approves on the till screen in one go; anyone else's request waits in Approvals.
- **Receipts by email** (decision 6): to the member's address, or an address typed for a walk-in;
  sent again on request. It says what was bought, the total, any discount, and how it was paid
  ("Card", "Cash", "Tab"), never card digits.
- **A Till pack** (`packs/till`) gives the screens (the till, sessions and cash-up, today), its
  tools, permissions and a dashboard. It `requires: ["shop"]` for goods (stage 37) and sells what
  the Shop and other packs declare; it defines no item of its own.
- **Memberships at the desk** (decision 4) start a subscription on the provider's hosted page,
  opened on the tablet for the member to type their card, or sent to them by email; staff choose.
  The reader is for one-off payments.
- **What a customer sees is in My account** (stage 48): desk orders in the base Orders section; the
  tab as a section and an attention kind (below). No separate customer area.

### The seams with other stages

| Stage | It owns | The till uses it as |
| --- | --- | --- |
| 37 Shop | Items, variants, `sellable.goods.soldIn`, `stock`, the channel rule in `createOrder`, `order.quote`, `order.return` | Desk orders are in person; goods lines are checked by the Shop's rule; stock holds and `sold` come from the order hook; a return asks the refund and the till says how it goes back |
| 34 Offers | `priceLines` (lines, adjustments, delivery), `order.adjust`, codes and members' prices, the shared step (`applyOtherPayment`, `method`, refunds by method, `rec_order_payment`, ADR 0694), stored value | The desk catalogue and totals come from `priceLines`; staff discounts by `order.adjust`; cash is `recorded` / `cash` through `applyOtherPayment`; the tab adds the `account` method to the shared step's list (below); gift cards at the desk by `order.applyStoredValue` |
| 48 My account (PR #311) | The shell, sections, `me.portal`, `me.attention` and its kinds | Desk orders show in Orders; the tab is a base section shown on a `me.portal` flag and a core attention kind `tab_owing` |
| 51 Kiosk check-in | The enrolled shared device (enrolment, the device credential, revocation) | The fridge tablet (a later step) runs on it. The staff till does not: it runs under the member of staff's own sign-in |
| 44 Agreements | `agreementsDue`, the desk signing session | Desk orders and memberships refuse with `agreements_due` as online; staff sign at the desk on stage 44's session |
| 52 Finance reports | Figures for the books (sales by kind and tax, payouts) | The till's own screens show only the day's takings for the cash-up; the books' figures are stage 52's, from the same payment rows |
| 35 Invoices | Invoices, statements, trade accounts, a receipt document | A tab is not an invoice; a downloadable receipt waits for stage 35 (stage 48 decision 7) |
| 30 Notifications | Consent to be contacted | Receipts and tab reminders are transactional host mail and routine mail, not marketing |

If the till's cash step starts before stage 34's step 3 has, it builds the shared step itself, to
stage 34's design, and writes its ADR in this stage's block (ADR 0772; 0694 then stays free, as
stage 34 says). If stage 34's step 3 is in flight, the till waits for it.

If the till's step 1 starts before the Shop's steps 1 and 3 have merged, it takes the
`sellable.goods.soldIn` part of the Shop's step 3 with it, as stage 37 defines it.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **Keep taking money outside the host** (today's `paidAtDesk`) | Stock, passes and the day's takings stay unknown to the host; a cash-up is impossible |
| **The till's own "paid by a person" door** (the draft's `method` list and `order.takeCash` writing payment rows itself) | Stage 34's shared step is one door, one row shape, one guard, one ADR. The till adds an operation and a method on it |
| **A cash payment as a fake provider event** | `core_payment_event` means "what the provider said"; a person's word gets its own row, marked as theirs |
| **Prices typed at the till** ("custom amount") | Breaks "the host prices the order" and is how takings go missing. A business that needs it adds a catalogue record; money off is `order.adjust` with a reason, within the owner's limit |
| **A reader driven from the tablet** (paired to the device, the provider's code in the browser or app) | Puts the provider's code and a connection secret on a shared device and makes web and native differ. A server-driven reader: the host asks, the reader shows, the webhook reports |
| **The tab added to the member's next membership payment** | The owner chose no (decision 1): it charges a stored card for something the member did not approve at that moment |
| **A tab as stage 34's account credit with a negative balance** | Stored value is money the host holds for a customer; a tab is money the customer owes. Different liability, limits and reports. Its own ledger |
| **A tab as unpaid orders left open** | Holds would never release, stock would sit held, and "unpaid" would mean two things. The tab order is paid by the tab; the tab is what is owed |
| **A separate catalogue for the desk** | Two lists and two counts for one shirt. The Shop owns items and stock (decision 9) |
| **A standalone till app** | Stage 47 already gives staff screens in the admin, on a tablet's browser; a second app is a second sign-in |
| **A kiosk sign-in for the desk till** | The staff till runs under the member of staff's own sign-in, so every sale and cash movement names a person. The enrolled device (stage 51) is for the self-serve tablet, where no member of staff is signed in |
| **The tab on the self-serve tablet** | Whoever is at the fridge could charge a member's tab. On the self-serve tablet the member pays on the reader; the tab is at the staffed desk |

## Platform work and pack work

| # | Piece | Kind | Notes |
| --- | --- | --- | --- |
| P1 | **Desk orders**: `placedAs: "desk"`; for a Person, an address or nobody (goods only); in person by the Shop's channel rule; their own expiry; the session they were started in | Platform (core `orders/`, `fields/order.ts`, a migration) | Amends ADR 0428 and CONTEXT "Guest": a desk order may have no address |
| P2 | **The desk catalogue**: `order.deskCatalogue`, a staff read over every object that declares `sellable` and is sold in person (goods by `soldIn`, others unless their object opts out), priced through `priceLines` for the order's buyer, with what is available | Platform (core `orders/`) | Reads the Shop's `soldIn` and `stock`; no new mark for goods |
| P3 | **Tills and till sessions**: a till list (admin-managed), sessions opened with a float, cash in and out, closed with a count and the difference; one open session per till, refused by the database; a closed session never changes | Platform (core `till/`, a migration) | The money's integrity is the host's, so the session is not pack data |
| P4 | **Cash at the desk**: `order.takeCash` on stage 34's shared step: a `recorded` row, kind `cash`, the session, tendered and change | Platform (core `orders/payments.ts` through `applyOtherPayment`) | Needs the shared step (built by stage 34, or by this stage first) |
| P5 | **Card on a reader**: the gatekeeper's in-person payments, readers registered by a person, `order.presentOnReader` / `cancelOnReader`, the reader's events, the fake reader | Platform (`gatekeeper-payments`, core `orders/gateway.ts`, `orders/events.ts`, `integrations/`) | Amends ADR 0429. The payment is `provider`, through the one verified door |
| P6 | **Refunds at the desk**: cash refunds handed over from an open till; tab refunds back onto the tab; card-present refunds through the existing action | Platform (core `orders/refunds.ts`, `till/`) | On stage 34's refunds by method |
| P7 | **The desk receipt**: the confirmation mail says how it was paid; to a typed address; sent again on request | Platform (core host mail, `orders/events.ts`) | |
| P8 | **Tax on a desk sale**: with tax on, the provider's tax calculation with no charge (the gatekeeper action stage 34 step 8 adds), at the business's address, stored on the order | Platform (`gatekeeper-payments`, `orders/tax.ts`) | Amends ADR 0479. The host never calculates tax |
| P9 | **The tab**: a Person's tab (a ledger of charges, payments and credits), its limit, the `account` method on the shared step, the tab payment order, reminders, the attention kind and section flag | Platform (core `tabs/`, a migration; `me.attention`, `me.portal`) | Amends ADR 0694 (one more method) and stage 48 (one kind, one flag) |
| P10 | **The self-serve tablet** (later): a till of kind `self_serve` on stage 51's enrolled device, a member identified as stage 51 identifies them, goods only, card on the reader only | Platform (core `till/`) and pack | After stage 51 and P5 |
| T1 | **The Till pack** (`packs/till`): tools over P1 to P10, permissions, screens (stage 47), the Today dashboard, views, routine mail, hooks and web blocks | Pack | No new behaviour; composes the above |
| T2 | **Bookings at the desk**: with the Till installed, a walk-in's drop-in is sold through the till (Bookings' tool starts the held booking and its desk order), so the money is recorded; `paidAtDesk` stays for businesses without the Till | Pack (`packs/bookings`) | Small |
| T3 | **Memberships at the desk**: start a membership on the tablet's provider page or by emailed link (decision 4) | Pack (`packs/memberships`) | Small; `subscription.start` as it is |

### What the payments gatekeeper needs for a card reader

The provider the repo names offers in-person payments where the reader is driven from the server.
From `src/provider.ts` and `src/stripe.ts`:

- **Readers belong to the payment account.** A reader is registered to the business's provider
  account at a location (an address the provider requires). Registering is an admin's act in
  Settings → Integrations: the reader shows a code, the admin types it with a label ("Front desk")
  and picks the till it serves; the gatekeeper registers it and keeps `{ ref, label, location }`.
  New provider methods `registerReader`, `listReaders`, `removeReader`. Registering moves no money
  but adds a device that can take it: an outbound action a person approves, never an AI.
- **Presenting a payment.** `presentPayment({ orderId, amount, currency, readerRef,
  idempotencyKey })`: the provider's card-present payment for that amount, the host's order id in
  its metadata, handed to that reader. An observation, no approval (as `createCheckout`: no money
  moves until the buyer's card does). `cancelPresented(readerRef)` clears the reader.
- **Events.** The webhook mapping gains the card-present payment's success (the same `payment`
  event, its reference as both `checkoutRef` and `paymentRef`) and the reader's action failing or
  being cancelled (a new `reader` event, so the till can say "declined, try again"). The host
  matches on the reference it stored when it presented (`core_order_checkout` with a new kind
  `reader`), never on what the metadata says.
- **Refunds** of a card-present payment use the existing `refund` on its payment reference.
  Whether every card can be refunded without the card present differs by country and card network:
  to verify against the provider's documentation and a test account for the business's country.
- **The key.** The gatekeeper's restricted key needs the in-person permissions; the runbook
  (`docs/payments-stripe-runbook.md`) says which.
- **The fake provider** gains fake readers: a page per reader with "Tap card", "Decline" and
  "Cancel", delivering signed events as its checkout page does, so tests and e2e need no device.
- **Not needed here**: tipping, payments while the reader is offline, the reader printing receipts,
  saving a card from the reader for later charges.

## The model

### Records and states (core)

- **Order**: new `placedAs` value `desk`; `till_session_id`; an address that may be empty for a
  goods-only desk order. A desk order expires after the desk expiry setting (default 15 minutes)
  if nothing pays it, releasing its holds.
- **Order payment** (stage 34's `core_order_payment` with `method`):
  - card on a reader: `provider`, as any verified payment, with the reader's ref;
  - cash: `recorded`, `recorded_kind: cash`, `recorded_by` (the person), plus this stage's
    `till_session_id`, `tendered` and `change` (informational);
  - tab: a new method **`account`**, with the tab entry it pays; the shared step's trigger gains one
    rule, as for `stored_value`: an `account` row without its tab `charge` entry in the same batch
    is refused.
- **Till** (`core_till`, admin-managed): name, kind `drawer` (a cash drawer at a place), `person`
  (a technician's own cash, later) or `self_serve` (card only, later), the readers it uses, active.
- **Till session** (`core_till_session`): `open` → `closed`. Opened by a person with a counted
  float; at most one open session per till (a partial unique index). **Cash movements**
  (`core_till_movement`, append-only): `float`, `sale`, `refund`, `paid_in`, `paid_out` (with a
  reason: change bought, petty cash), each by a person. Closing stores counted, expected
  (float + sales − refunds + paid in − paid out) and the difference, and the session's totals by
  method. A closed session never changes; a correction is a note added by someone with
  `till:cashup`. Triggers refuse update and delete of movements and of a closed session, and
  `INSERT OR REPLACE` (issue #269's lesson).
- **Tab** (`core_tab`, `core_tab_entry`): one per Person, made on first use. Entries, append-only:
  `charge` (an order paid by the tab), `payment` (a tab payment order paid), `credit` (a refund back
  onto the tab). The balance owed is kept by a trigger, which refuses a charge past the limit. The
  limit is the business's default (setting `till_tab_limit`, default 0: tabs off) or the Person's
  own, set by a human admin.

### Operations (core)

| Operation | Audience | Who may | Risk | Notes |
| --- | --- | --- | --- | --- |
| `order.startAtDesk` | staff | `till:sell`, in the caller's open session | write | A Person, an address, or nobody (goods only); agreements enforced as today |
| `order.deskCatalogue` | staff | `till:sell` | read | What is sold in person, priced for the buyer, availability; bounded |
| `order.presentOnReader` | staff | `till:sell`, a person | write | `hostInternal`, as `order.checkout`; one live presentation per reader |
| `order.cancelOnReader` | staff | `till:sell` | write | Clears the reader; the order stays pending |
| `order.takeCash` | staff | `till:sell`, `actors: ["human"]`, in the caller's open session | write | At least what is due; through `applyOtherPayment` |
| `order.payFromTab` | staff | `till:sell`, `actors: ["human"]` | write | A Person's order, within their limit |
| `till.open` / `till.close` | staff | `till:sell` to open; close by the opener or `till:cashup`; human only | write | Close records the count |
| `till.move` | staff | `till:sell`, human only | write | Cash paid in or out with a reason |
| `till.sessions` / `till.session` | staff | own with `till:sell`; any with `till:cashup` | read | Totals by method |
| `till.note` | staff | `till:cashup`, human only | write | A correction note on a closed session |
| `till.handOverRefund` | staff | `orders:refund` or the asker once approved; human only, in an open session | write | Records an approved cash refund handed over; lowers expected cash |
| `order.refund` (stage 34's, by method) | staff | asks: `till:sell`; approves: `orders:refund` | outbound / write | Card as ADR 0429; cash then `till.handOverRefund`; tab as a `credit` entry in the approval's batch |
| `tab.get` | staff, customer (own) | `till:sell`; the Person | read | Balance, limit, entries |
| `tab.setLimit` / `tab.settings` | staff | human admin only | admin | Loosening is human-admin-only |
| `order.startTabPayment` | staff, customer (own) | `till:sell`; the Person signed in | write | An order with one host-made "Tab payment" line, at most the balance; pays as any order |
| `order.sendReceipt` | staff | `till:sell` | write | To the order's address or one typed; rate limited |
| `reader.register` / `reader.remove` | staff | human admin; outbound action a person approves | outbound | Settings → Integrations |

Opened to customers: `tab.get` (their own) and `order.startTabPayment` (their own tab), both a
reviewed change (ADR 0402), `mcp: { expose: false }`, rate limited. The emailed link opens the
business's website account page, where the signed-in member starts the payment and pays it on the
provider's hosted page through the existing `order.checkout`. Nothing is opened to the public.

### Tools (Till pack)

`catalogue`, `sell`, `onReader`, `cancelReader`, `takeCash`, `payFromTab`, `openTill`, `closeTill`,
`cashMove`, `handOverRefund`, `sessions`, `today`, `receipt`, `refundAtDesk` (asks `order.refund`),
`tab`, `settleTab`. Every tool that moves money, opens or closes a till or touches a tab is
`humanOnly`.

**Permissions**: `till:sell` (every member of staff; grantable to a pack role, so a coach who works
the desk is granted it as with `bookings:desk`, ADR 0600): sell, take cash and card, put on a tab
within its limit, open and close their own session, ask a refund. `till:cashup` (restricted, ADR
0625): see every session and the day's totals, close someone else's session, add correction notes.
Refunds stay core `orders:refund`; desk discounts stay stage 34's `orders:discount`; gift cards at
the desk stay `orders:payments`.

### Screens

- **Web admin (stage 47), laid out for a tablet**:
  - *Till*: search a member or "walk-in", tap items from the catalogue, the total (with any
    discount), then Card / Cash / Tab; for card, the reader's state, read by polling the order every
    two seconds; for cash, the amount tendered and the change; "Send receipt". Opens with `sell`.
  - *Till sessions*: open with a float, paid in and out, close and count, refunds to hand over.
    Opens with `openTill`.
  - *Today*: takings by method, refunds, differences; own sessions with `sessions`, everything with
    `till:cashup`.
  - *Tab*, a record screen on Person: balance, limit, entries, "Take payment". Opens with `tab`.
- **Customer (stage 48)**: desk orders in the base Orders section; a **Tab** base section (shown
  when `me.portal` reports `hasTab`: a balance or entries) with the balance, the entries and "Pay
  now"; an attention kind **`tab_owing`** ("Your tab: an amount to pay") while the balance is above
  nothing. The tab is a core primitive, so its section is a base one, as Payment method is.
- **Native**: the shared logic in `packs/till/client`; the native till for a technician's phone is a
  later step. Paying the tab from the app opens the website, as stage 48 does for money.

### Notifications and mail

- **The receipt** (host mail) when a desk order is paid and has an address; for a member, always
  (decision 6). A tab charge's receipt says "On your tab" and the new balance.
- **A cash-up difference** of 10 or more (decision 7; setting `till_difference_alert`, human
  admins): the owner and `till:cashup` holders told at once; every difference in the daily digest.
- **A till left open** past the business's closing hour: whoever opened it and `till:cashup`
  holders told.
- **Tab reminder** (routine mail, ADR 0590, an admin turns it off): a member with a balance is sent
  a monthly reminder with the link to pay. Staff see tabs older than 30 days in the daily digest.
- An approved cash refund not yet handed over after a day: `till:cashup` holders told.

### Tax

Prices include tax, as everywhere (ADR 0479). With tax off, nothing changes. With tax on, a desk
order's tax is the provider's tax calculation with no charge (the gatekeeper action stage 34 step 8
adds for gift cards), for each net line with its tax code, at the business's address, stored on the
order as a checkout's tax is. A tab payment line carries no tax code: the tax was on the sale. If
the till reaches this before stage 34 step 8 has built the action, the till builds it to that
design. What a desk receipt must show about tax is for the business to confirm with its accountant.

### What an AI may do

- Read the catalogue, sessions, the day's totals (for an account holding `till:cashup`) and a tab;
  answer "what did we take today"; draft a refund request, which waits for a person as every refund
  does.
- **Never**: take cash, open, close or count a till, move cash, hand over a refund, put an order on
  a tab, change a tab's limit, register a reader, present a payment on a reader, or approve a
  refund. Those operations are human only; a presented payment needs a person at the desk anyway.

### Privacy and erase

- Card data never reaches the platform; a receipt says "Card", nothing more.
- A walk-in's goods-only order may hold no Person and no address. An address typed for a receipt is
  kept on the order as a guest's is (ADR 0428), not added to a Person unless it matches one.
- Audited: every desk order, cash taken, cash moved, session opened and closed with counts,
  correction, refund asked, approved and handed over, tab charge, payment and credit, limit change,
  reader registered or removed, receipt sent (the address hashed, as the email gatekeeper does).
- Who sees what: `till:sell` holders see their own sessions and the orders they took, and a
  member's tab balance (to tell them what they owe); `till:cashup` holders see all sessions and
  takings; the member sees their own orders and tab. The till shows of a member only their name,
  photo if any, and tab: never health answers or notes.
- **Erase**: orders stay for the books with the Person detached (as today); a tab with a balance
  owing is reported to the admin at erase and its entries keep their amounts with the Person
  detached; till sessions keep the staff member's id after their account is removed, shown as
  "former staff". How long sales and cash-ups are kept is for the business to confirm with its
  accountant.

## Out of scope

- Printed receipts, cash drawers that open by themselves, barcode scanners, scales.
- Tipping, offline card payments, saving a card on the reader for later.
- A downloadable receipt document (stage 35, stage 48 decision 7).
- Invoices, statements and trade accounts (stage 35); jobs (stage 39).
- Scanning a member's code at the desk (issue #236), though the till screen leaves room for it.
- A native till screen and the technician's till per person (later steps).
- The books' figures (stage 52) and sending them to an accounting system (stage 61).
- More than one currency.

## Acceptance criteria

1. A member of staff opens a till with a float, sells a walk-in a Shop drink sold in person for
   cash with no name or address: the order is paid with a `recorded` / `cash` row naming them and
   their session, stock writes `sold`, and the session's expected cash has risen by the price.
2. A drink sold online only is refused on a desk order, by the Shop's channel rule, on every path.
3. A desk order for a member, paid on the fake reader, becomes paid only when the fake provider's
   signed event arrives; the till shows paid; a decline leaves it pending and the till says so; a
   retry after a timeout charges once.
4. A class pack sold at the desk grants the pass as a web sale does; a walk-in's drop-in is booked
   through the held booking and its paid desk order, and is not marked `paidOtherwise`.
5. A pass or drop-in with no holder (no Person, no guest email) is refused.
6. `order.takeCash`, `order.payFromTab`, the till moves and `till.handOverRefund` are refused for an
   assistant, an MCP client, an automation and another extension's code, and for a person with no
   open session where one is needed. Cash less than what is due is refused.
7. One till cannot have two open sessions (the database refuses the second, under a race).
8. Closing a session stores expected, counted and difference; a difference of 10 or more tells the
   owner at once; a closed session and its movements cannot be changed by any statement shape.
9. A card refund is approved only by a person with `orders:refund`; a cash refund, once approved, is
   handed over from an open till and lowers expected cash; a tab refund credits the tab in the
   approval's batch; an AI can approve none.
10. A price, total or amount sent to any desk operation changes nothing; the host prices through
    `priceLines`, and a staff discount is stage 34's `order.adjust`.
11. A tab: off by default; within its limit an order is paid from it with an `account` row and a
    `charge` entry in one batch; over the limit refused by the database; paid off at the desk by
    cash or card, or by the member from the emailed link signed in on the website; nothing charges
    a stored card.
12. A member with a balance sees the Tab section and a `tab_owing` attention item in My account; a
    member with none sees neither.
13. The receipt goes to the member's address on payment, or a typed address for a walk-in, says how
    it was paid, and holds no card details.
14. `till:cashup` is held only by admins and accounts a human admin granted (ADR 0625); a coach
    granted `till:sell` sees the Till and not others' takings.
15. A reader is registered only by a person approving the action; an AI cannot register one.
16. Starting a membership at the desk opens the provider's page on the tablet or emails the link,
    as staff choose; `agreements_due` refuses it as online.
17. With tax on, a desk order stores the provider's no-charge calculation per line; with tax off,
    nothing is sent.
18. Statement counts: the catalogue read, the till's polling read and a session's close run a
    bounded number of statements.
19. E2E at tablet width, one test per journey: a cash sale, a reader sale, a refund, a cash-up, a
    tab charged and paid off.
20. `cos ext check packs/till` and `cos ext test packs/till` pass.
21. The site: `SITE.md` and the gym page say staff sell at the desk once built, and nothing before.

## Dependencies

- **Stage 37, Shop** (agreed): `sellable.goods.soldIn`, `stock` and the channel rule (its steps 1
  and 3) before goods are sold at the desk. Passes and drop-ins can be built and tested without it.
- **Stage 34, Offers** (agreed): `priceLines` with adjustments (step 1) and the shared step (step
  3), unless the till builds the shared step first; the no-charge tax calculation (step 8) for tax.
- **Stage 47, pack screens** (agreed, being built): the till's screens.
- **Stage 48, My account** (PR #311): the Tab section and the `tab_owing` kind.
- **Stage 51, Kiosk check-in** (specced separately): the enrolled device, for the self-serve tablet
  only.
- **Stage 44** (built in part): agreements due at purchase; the desk signing session.
- Built: stage 25 (orders, the gatekeeper), 26 (capacity and holds), 27 (sellable), 31a and 32b
  (drop-ins, passes, memberships), 42 (tax at checkout), routine mail (ADR 0590).
- A **real reader and a provider test account** for the business's country, for the last step.

## Migrations and numbers

Block **BL**: migrations 1110 to 1129, ADRs 0770 to 0779. Expected migrations: desk orders (the
`desk` value, `till_session_id`, a nullable address for desk orders); tills, sessions and movements
with their triggers; the cash columns on the payment row; the reader checkout kind; tabs and their
entries with the balance and limit trigger, and the `account` method in the shared step's guard;
later, the self-serve till. If the till builds the shared step first, its migration is in this
block. A `core_write_guard` remake only if a step needs a guard kind, following the ordering rule
in `parallel-work.md`. No `x_*` table is touched. ADRs the build writes:

| ADR | Decision | Amends |
| --- | --- | --- |
| 0770 | Desk orders: `placedAs: "desk"`, in person, a goods-only order with no buyer, the desk expiry | 0428 |
| 0771 | Tills and till sessions: cash held in a session, the cash-up, the difference, nothing changed after close | |
| 0772 | An order paid another way, **only if the till builds stage 34's shared step first** (else free, and 0694 is written by stage 34) | 0427, 0429, 0479 |
| 0773 | Cash at the desk: `order.takeCash` on the shared step, in an open session, human only | 0694 (or 0772) |
| 0774 | Card on a reader: server-driven readers, registered by a person, matched on the host's stored reference | 0429 |
| 0775 | Refunds at the desk: cash handed over from an open till, tab payments credited back | 0429, 0694 |
| 0776 | The tab: a Person's ledger of what they owe, its limit, the `account` method, paid off when the member chooses | 0427, 0694 |
| 0777 | Tax on a desk sale: the provider's calculation with no charge | 0479 |
| 0778 | The self-serve tablet: card only, on an enrolled device (later step) | |

## Suggested build order

| Step | What | Files or areas | Beside / collides |
| --- | --- | --- | --- |
| 1 | Desk orders (P1) and the desk catalogue (P2) | `orders/` (`orders.ts`, `sellable.ts`), `operations/order.ts`, `fields/order.ts`, a migration | After Shop steps 1 and 3 and Offers step 1 (all in `orders/`), or takes `soldIn` with it. Beside 4a. **Collides** with every `orders/` branch (Shop, Offers, PR #299) |
| 2 | Tills, sessions and cash (P3, P4); the shared step if nobody has built it | new core `till/`, `orders/payments.ts`, `operations/order.ts`, `principals.ts`, a migration | After 1. **Collides** with Offers step 3 and stage 35 step 4 (the same shared step: whichever starts first owns it) and any `orders/` branch |
| 3 | The Till pack spine: tools, permissions, the Till and Sessions screens, cash sales end to end | `packs/till`, its blocks and hooks, `pack-roles.ts` only if a role needs it | After 1, 2 and stage 47. Beside 4a and 4b. **Collides** on `pack-roles.ts` |
| 4a | The gatekeeper's in-person payments and fake readers (P5, gatekeeper half) | `packages/gatekeeper-payments/src/` (`provider.ts`, `stripe.ts`, `fake.ts`, `events.ts`, `types.d.ts`, `validate.ts`) | Can start first, beside 1 to 3. **Collides** with Offers steps 6, 8 and 9 in the gatekeeper |
| 4b | The host's reader path: `order.presentOnReader`, reader events, readers in Settings → Integrations | `orders/gateway.ts`, `orders/events.ts`, `integrations/`, `apps/app` settings | After 4a and 1. **Collides** with `orders/events.ts` work |
| 5 | Refunds at the desk (P6) | `orders/refunds.ts`, `till/`, `operations/approval.ts` | After 2, 4b and the refunds by method. **Collides** with Shop step 4 (returns) and refund-due work |
| 6 | Receipts (P7) and tax on a desk sale (P8) | core host mail, `orders/events.ts`, `orders/tax.ts`, the gatekeeper's no-charge tax action | Beside 5. **Collides** with Offers step 8 on the tax action and with email-send work |
| 7 | Cash-up, Today, notices, dashboard | `packs/till`, the core daily digest | After 2. Beside 4 to 6 |
| 8 | Bookings and Memberships at the desk (T2, T3) | `packs/bookings/tools.ts`, `packs/memberships` | After 3. **Collides** with work in those packs |
| 9 | The tab (P9): ledger, limit, `account` method, tab payment order, reminders, the Tab screen, My account's section flag and attention kind | core `tabs/`, `orders/payments.ts`, `operations/me.ts`, a migration, `packs/till`, base-layer account blocks | After 2 and stage 48's `me.attention`. **Collides** with `orders/` and stage 48's build |
| 10 | The real provider: test-mode readers, then a real device at the first client; the runbook | `docs/payments-stripe-runbook.md` | Needs a person, a device and an account |
| 11 | Later: the self-serve tablet (P10) on stage 51's enrolled device | `till/`, `packs/till` blocks | After 4b and stage 51 |
| 12 | Later: several readers and desks; a till per person and the technician's phone screen | `till/`, `packs/till/client`, native blocks | When a client needs them |

**What can start first:** step 4a (the gatekeeper) at once, beside everything outside the
gatekeeper. Step 1 waits for the Shop's and Offers' first `orders/` steps or goes in their place,
by agreement: `orders/` takes one branch at a time.

## Size

**Large.** Up to three sessions at once: the core track (1, 2, 5, 9 in turn), the gatekeeper track
(4a, then 4b), and the pack track (3, 7, 8 once 1 and 2 merge). Receipts and tax (6) go to whichever
track is free.

## Decided by this spec, open to override

- A desk sale is an ordinary order with `placedAs: "desk"`, in person by the Shop's channel rule;
  no separate sales record.
- Nothing typed at the till is a price; money off is stage 34's `order.adjust` within the owner's
  limit.
- Cash is stage 34's `recorded` payment of kind `cash`, made by `order.takeCash` in an open session;
  the session is host data, not pack data.
- Every desk sale at a drawer till belongs to an open session, so the cash-up shows every method.
- The reader is server-driven; nothing of the provider's runs on the tablet. A card-present payment
  is a `provider` row through the one verified door.
- Refunds go back the way they came: card to card, cash in cash from an open till, tab to tab; every
  refund approved by a person with `orders:refund`; an approved cash refund is handed over and
  recorded in a session.
- Goods alone may be sold to nobody; a pass or drop-in needs its holder. A drop-in is its own order,
  as online.
- Records that are not goods (passes, drop-ins) are sold at the desk unless their object opts out;
  no new mark for goods.
- The tab is the host's own ledger, not stored value and not open orders; off until a human admin
  sets a limit; `till:sell` may charge it within the limit; only a human admin sets limits; a member
  is reminded monthly and pays when they choose; never charged to a stored card.
- A tab payment is an order with one host-made line, at most the balance, untaxed.
- The tab shows in My account as a base section and a core attention kind, `tab_owing`.
- Memberships at the desk use the provider's page on the tablet or an emailed link, staff's choice;
  not the reader.
- The staff till runs under the member of staff's own sign-in; the enrolled device (stage 51) is for
  the self-serve tablet only, which takes card only, goods only, and no tab.
- With tax on, a desk sale's tax is the provider's calculation with no charge; the host never
  calculates tax.
- The till polls; no live connection (realtime is a later platform item).
- The desk expiry is 15 minutes; tab reminders monthly; tabs older than 30 days in the digest.

## Questions for the owner

None. The owner's answer on the tab is recorded (decision 1), and the other points were decided as
best practice. The facts about how the gym takes money today (decision 10) are checked with the
business during setup.

## For the business to confirm with its accountant or lawyer

- What a desk receipt must show, and whether tax must be shown on it.
- How long sales, cash-ups and tab records are kept.
- How a tab (money members owe) is shown in the books.
- Whether a card-present payment can be refunded without the card present, for the business's
  country (to verify with the provider too).

## Risks

- **Money and authority.** Cash is a payment no provider confirms. A person's word is audited, bound
  to an open session and counted at close; the cash-up is the control. Review that no AI,
  automation or extension code can reach `order.takeCash`, `order.payFromTab` or the till moves.
- **The shared step.** Everything that assumed "paid means the provider said so" (late payments,
  refunds, grants, subscription periods, reports) must hold for `recorded` and `account` rows. Stage
  34 owns that review; the till adds the `account` method and must re-run it.
- **Reader events.** Match on the reference the host stored, never on metadata; a payment presented
  twice must not charge twice (an idempotency key per presentation, one live presentation per
  reader).
- **A tab is credit given.** A limit, a receipt for every charge and the monthly reminder are the
  controls; a member who leaves owing is the business's to chase.
- **Privacy at a shared tablet.** The desk tablet is signed in as a member of staff: the admin's
  session timeout and what the till shows of a member (name, photo, tab) matter.
- **Needs a real device and account**: a reader in the provider's test mode, then a real one at the
  first client's desk; the admin on the gym's actual tablet; a real cash-up run by the gym's staff
  for a week.
- **Stage 47 at tablet width** is not yet tried; the admin's shell may need layout work.
