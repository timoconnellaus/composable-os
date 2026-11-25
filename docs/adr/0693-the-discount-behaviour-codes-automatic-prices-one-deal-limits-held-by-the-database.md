# ADR 0693: The `discount` behaviour: codes, automatic prices, one deal per order, limits held by the database

Status: accepted, 2026-11-25 (stage 34, build step 4; [the spec](../stages/34-offers.md)). Amends
[ADR 0435](0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md) (what is sold is
priced from its record: now less the record of a discount) and builds on
[ADR 0690](0690-adjustments-on-orders-net-lines-and-the-pricing-seam.md) (adjustments and the
pricing seam), [ADR 0691](0691-staff-discounts-orders-discount-the-limit-and-approval-above-it.md)
(staff discounts), [ADR 0692](0692-one-person-per-folded-address.md) (folded addresses),
[ADR 0683](0683-order-quote-a-public-dry-run-of-the-host-s-prices.md) (`order.quote`) and
[ADR 0685](0685-postage-priced-by-the-host.md) (postage). Opens `order.applyCode`,
`order.removeCode` and `discount.check` to customers and the public (ADR 0402: a reviewed change,
in `packages/core/open-operations.json`).

## Context
Step 1 gave orders adjustments and one pricing seam, with only staff discounts on it. The owner
asked for promo codes for a campaign and members' prices that apply with no code, one deal per
purchase, the better for the customer (decisions 1, 8 and 9), and "one per person" deals nobody
gets twice with a `+tag` (decision 7). A pack hooking order pricing is not allowed (ADR 0404), and
discounts as fixed core records were rejected (every business shapes them differently). The host
must price the deal so that a quote, the order and the provider's charge always agree, and the
limits must hold under orders started at once.

## Decision

**A new behaviour, `discount`** (`packages/sdk/src/discount.ts`). An object declares it and names
its fields: `kind` (a select of `percent`, `amount`, `price`) with `percent` and `amount`; `live`,
the states it applies in; how it applies (`automatic`, a boolean; `code`, one shared word; `codes`,
records of another object of the pack, with an optional `uses` per code, 1 for a single-use code,
and `active`); `who` (`anyone`, `signed_in`, `members` of `plans`, `new_customers`, `organisation`,
`tag`); what it applies to (`objects`, a multi-select of object names, and `records`, relation
fields; neither: every line but a delivery); `from` and `until`; `totalUses`, `perPerson` and
`minSpend`. The contract refuses wrong field types, kinds and audiences the host does not know, no
way to apply, codes that are not another object's records naming it, an object that is also
sellable, stocked or a capacity, and a live state anyone but a person can reach: a move into a live
state is by `["host"]` with the tools a person makes it through, or by staff writing a state field
declared `personApproves`; nothing is created live but by the host; the initial state is not live.
A runtime extension may declare it (criterion 24) with the second form, since it cannot declare a
staff permission.

**A live discount, and every promo code, is changed only by a person.** Besides moving one live,
these wait for a person when the actor is not a person (the assistant, an MCP client, an
automation, extension code), whatever the approval preset (`records/person-approves.ts`), as an
AI's publish does (ADR 0480): any `record.update` of a discount in a live state; any
`record.restore` of a discount (one a person deleted to stop it may be live again); and any
`record.create`, `record.createMany`, `record.update`, `record.restore`, `record.restoreVersion` or
`record.import` of a record of an object some discount names as its `codes` (a new word, more
uses, switched back on or pointed at another discount is a new way into a discount), whatever its
discount's state: simpler, and safe. An AI drafts; a person decides what buyers are charged
(review of PR #454).

**The deal is worked out in the seam.** `priceOrder` (`orders/orders.ts`) prices the lines, then
works out the deal (`discounts/deal.ts`, `workOutDeal`), then applies the goods rules and prices
the delivery. `order.start`, `order.startHeld` (its lines priced by the host for the record made
in the same batch), `order.quote`, `discount.check`, `order.applyCode` and `order.removeCode` all
call the same function, so a quote and the order agree. The rules:

1. Every live automatic discount the buyer qualifies for and the code, when one is given, are
   weighed on the lines as priced; the one that takes most off is the deal. On a tie, the
   automatic one: it spends nobody's code (decided: neutral to the buyer, decision 9). Automatic
   discounts are filtered in the query by live state, dates and, for a guest, audience, newest
   first, before at most 25 per discount object are weighed: ones out of date never crowd out
   one that applies.
2. A guest never qualifies for anything but `anyone`, nor for a discount with a per-person limit:
   the same answer for every address. A signed-in customer and staff buying for a Person do. A
   quote by staff names no Person, so it shows only what anyone gets.
3. `members`: the Person holds a subscription `trialing`, `active` or `past_due` (to one of
   `plans`, when it names any): decided, a subscriber whose payment the provider is retrying is
   still a member; passes do not count. `new_customers`: no paid order and no subscription that got past
   `incomplete` for any Person sharing a folded address. `organisation`: the Person's organisation
   (`rec_person.organisation_id`). `tag`: one of the Person's tags.
4. A percentage is rounded down on each line it applies to; an amount is spread over those lines
   by `splitInProportion`; a set price takes off the difference per unit, never below nothing.
   A minimum spend counts only the lines the discount applies to (decided: the usual shop
   convention).
5. A deal never makes an order free: one that would take every line but the delivery to nothing
   does not apply (a code that would is "not valid here"). Nor does one that would leave
   something to pay but less than the order setting `minCharge` (`order.settings.update`, a human
   admin's, 50 minor units by default): this is the spec's rule 5, the setting standing in for
   the payment provider's minimum charge, which the platform does not read. A code is then "not
   valid here"; an automatic discount is simply not applied. A staff discount may still take an
   order further (ADR 0691).
6. A delivery is never discounted, and free postage over an amount is decided after the deal, on
   the goods' net (the spec's rule 8; decision 12: it still applies beside a deal). A code put on
   a pending order later decides it again from the delivery's price and free-over as the order was
   started (`core_order_delivery.price`, `free_over`, migration 0953).
7. Deposits stay what the records say and the deal comes off the balance. A deal that leaves the
   deposit at or above what is owed starts the order paid in full.

**The deal is adjustments.** One `code` or `automatic` row of `core_order_adjustment` per line it
takes something off, naming the discount (`source_object`, `source_id`) and, for a percentage, the
percentage. Staff discounts are taken off after it (`liveAdjustments` orders the deal first,
whenever the code came), and counted against the staff limit alone.

**One answer for a code that does not apply.** Unknown, not live, outside its dates, used up, not
for this buyer, not for these items, under its minimum spend, or one that would make the order
free: `invalid_input`, "This code is not valid here", `{ rule: "code_not_valid", field: "code" }`,
for `order.start`, `order.startHeld` and `order.applyCode`; `order.quote` reports the same words
in `problems`; `discount.check` answers `valid: false` with the same message. Staff are also told
the reason (they read the discounts anyway). The database's refusal of a use past a limit (below)
is mapped to the same answer, so a race tells a caller nothing a read would not. A race lost on an
automatic discount (the buyer typed no code) is never told as a code: the trigger raises its own
message, the pipeline prices the call again once (it then goes through without that price), and
only a second loss in a row says "start again" (`rule: "deal_taken"`). Decided and recorded: a
code's existence can be told from how long the answer takes (a known word makes more reads than an
unknown one; the body is the same); left until the code lookup is reworked with the rate limit.

**Limits are held by the database** (`core_discount_use`, migration 0953), on `once.ts`'s shape: a
use per order with a deal, held in the order's own batch, `used` in the batch that first marks it
paid or part paid, `released` when the unpaid order expires or is cancelled, or when its code is
changed or taken off before it is paid. A refund keeps it used. A late payment honoured on an
expired order takes the deal's use again; past a limit since (another order took the last use)
`order.honourLate` is refused before anything is written, `rule: "discount_used_up"`, telling
staff to refund instead, as for something sold once per Person.
The limits are copied onto the use from the discount and code records as the host read them, and
a trigger refuses the use past `max_uses`, `code_max_uses` or `max_per_person` (every Person
sharing a folded address counted, with migration 0955's expression): of two orders started at
once at the last use, one exists. A person merge moves the merged Person's uses to the survivor;
an erase blanks their Person (the use keeps its discount, order and amount, as the order keeps
its money), as the order loses its Person.
`rec_discount_use` reports them.

**Operations.**
- `order.start` and `order.startHeld` take an optional `code`; both answer with `deal` (its kind,
  the discount's name, what it took off) and `codeApplied` (false when a better deal applied).
- `order.quote` takes an optional `code` and answers with each line's `discount`, the order's
  `discount`, `deal`, `codeApplied` and the total after the deal. It holds no use and writes
  nothing.
- `order.applyCode { id, token?, code }` and `order.removeCode { id, token? }` (staff; a customer,
  their own order; the public, with the order's token): only on a pending order before its payment
  page opens. The deal is worked out again from the prices the order's lines were started at, the
  order's own Person and how it was placed; the old deal's rows are marked removed and its use
  released, the new deal's written and its use held, in one batch; the host reprices the order.
- `discount.check { code, lines }` (staff, customers, the public; `actors: ["human"]`, not offered
  to an assistant or over MCP): whether the code applies to those lines for this caller, what it
  takes off each, and whether a price that applies by itself would beat it. Read-only.

No input of any of them carries an amount, a percentage or a total.

**Cost.** One read per discount object for automatic discounts, two per object for a code (its own
word and its code records), one grouped read of uses, at most one of uses per Person, and only
what a candidate's `who` needs (one read of the Person's subscriptions, of their row, of whether
they are new), shared across candidates: a bounded number of statements per call, beside
`priceLines`'s per-line reads.

## Consequences
- A pack declares discounts and never touches an order: the Offers pack (step 5) declares the
  discount, promo code, member price and customer rate objects on this behaviour.
- Rate limits, decided and recorded: guessing codes is not rate limited yet. A customer's calls
  are limited per account and operation at the HTTP surface (the pipeline's
  `CUSTOMER_RATE_LIMIT`); a public caller's are not (a known platform gap: public operations have
  no per-address limit). The spec's "20 wrong tries from one connection are slowed" (criterion 3)
  waits for that platform slice, with a normalised indexed code column, non-ASCII folding and a
  least code length. **Until the platform's per-address limit for public operations exists, no
  shipped pack may declare `discount`: this gates stage 34 step 5.**
- A staff percentage given before a code keeps its amount (decided): it was given on the order as
  it then stood, and is not worked out again on the net after a later deal.
- For a runtime extension's discount (the `personApproves` state-field form), any staff member who
  may edit the object can move it live; the tool form of a shipped pack also needs the pack's
  permission. The spec asks only for a person.
- Subscriptions (a code for 1 or N periods, `subscription.start`'s `code`) are step 6; referrals'
  `invite` and the `referral` kind are step 9; blocks and screens are step 10.
- A live discount's terms and every promo code can be written only by a person; a shipped pack's
  tool that writes one waits for a person too (its write is the extension's).
