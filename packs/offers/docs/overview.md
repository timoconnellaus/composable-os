---
title: Offers
summary: Money off, as discounts the host applies when it prices an order - promo codes, batches of single-use codes, members' prices and customer rates - each with its dates and limits, made live by a person.
stage: 34
spec: docs/stages/34-offers.md
adrs: [0552, 0628, 0690, 0692, 0693, 0699, 0940]
---

## What it is for

Offers is where a business keeps the money off it gives: a promo code for a campaign (`JANUARY26`),
a batch of single-use codes for a newsletter, a members' price on drop-in classes that applies with
no code, or a rate for an organisation's people. Each says what is off, on what, for whom, when and
how often. Staff, or the assistant, draft one; a person makes it live. From then on the host takes
it off every order it covers, on the website, in the app and at the desk alike.

It requires no other pack. What a discount covers is named by the objects the other packs sell
(drop-ins, event tickets, class passes, courses, course bundles, shop goods); a discount for one
that is not installed covers nothing.

## Concepts

- **Discount** (`offers.discount`): what is off (a percentage, an amount off the order, or a set
  price for each), how it applies (by itself, or by a shared promo code), who it is for (anyone,
  signed-in customers, members, new customers, an organisation's people, people with a tag), what
  it covers, its first and last day, and its limits (uses in total, uses per person, a minimum
  spend). Draft, live, paused or ended.
- **Promo code**: the shared word on a discount, which anyone may type. The host keeps it in
  capitals without spaces and refuses one shorter than six characters or one another discount has.
- **Single-use code** (`offers.code`): one of a batch of random codes made for a discount, each good
  for a set number of orders (one, by default), switched off when voided. The host keeps only its
  hash.
- **Member's price** and **customer rate**: discounts that apply by themselves to members, or to an
  organisation's people.

## How the pieces fit

- **The host prices the order.** A discount is a record of an object with the
  [discount](/reference/behaviours/#discount) behaviour. When an order is started or quoted, the
  host weighs every live discount that applies by itself and the code given, and takes off the one
  that takes most (a tie goes to the one with no code). It keeps the limits in the order's own
  batch, so two orders at once cannot both take the last use, and gives a buyer one answer, "This
  code is not valid here", for every reason a code does not apply. Nothing in the pack works out a
  price.
- **A person makes it live.** A discount is made as a draft and applies to nobody. Making it live,
  pausing, ending it, changing its terms and voiding codes are tools a person with `offers:manage`
  calls; when the assistant asks for one, the call waits in Approvals for a person, who sees the
  discount's terms in words, and approving it is refused if they changed after it was asked. A
  change to a discount past its draft (live, paused or ended) by the assistant, an MCP client, an
  automation or code waits for a person by any path. A person's own tools are never held up by the
  approval policy. A draft, live or paused discount goes in the Trash only by a person with
  `offers:manage`, never by the assistant or an automation; an ended one like any other record.
- **Single-use codes are shown once.** A person makes a batch at the discount's page; the answer
  holds the codes, to export or send, and nothing else ever does: the host keeps only each code's
  hash, refuses anything else in its place, and hashes what a buyer types to find it. Codes are in
  no record, list, query or audit row, and a code a buyer types is kept out of the audit log too.
  The assistant cannot make codes.
- **Nothing is public.** Discounts and codes are staff records. A buyer learns of a discount only
  through the host's `discount.check`, `order.quote` and the order's deal.
- **Members** are people holding a live subscription (one on trial or whose payment is being
  retried included). A guest never gets anything but a discount for anyone with no limit per
  person, whatever address they type; addresses with a `+tag` count as one person.

## Main flows

1. **A campaign code.** `draftDiscount` with a name, a percentage and a `code`; check it with
   `discounts`; `activateDiscount` makes it live. A guest types the code at checkout and pays the
   discounted price.
2. **A members' price.** `draftDiscount` with `automatic`, `who: members`, a set price and
   `appliesTo` drop-in classes; once live, a signed-in member's drop-in costs that price and a guest
   using their address pays the full one.
3. **Codes for a newsletter.** Draft a discount with no code, make it live, then `generateCodes`
   (up to 500 a batch, written 50 at a time) and keep the list it answers with. `codeBatches` shows
   how many were made, still work and were used; `voidBatch` stops a batch, and `voidCodes` (a
   person at the screen) the codes typed in. No codes are made for an ended discount.
4. **Stop it.** `pauseDiscount` until it is made live again, or `endDiscount` for good. Orders
   already started keep their deal.
5. **See what it did.** `discounts` lists each discount's uses and the money it took off; the Offers
   dashboard shows the live discounts, the discount given, the orders and revenue with a discount,
   and each discount's share.

## What is built

Discounts and single-use codes, the views (live, drafts, members' prices and customer rates, promo
codes), the single-use codes tab, the Offers dashboard, `offers:manage`, and the tools `discounts`,
`codeBatches`, `draftDiscount`, `changeDiscount`, `activateDiscount`, `pauseDiscount`,
`endDiscount`, `generateCodes`, `voidBatch` and `voidCodes`.

Not in the code yet: discounts on memberships for a number of payments, gift vouchers, gift cards
and credit, referrals, loyalty, the code fields on the buy pages, the staff screens and a discount
for members of chosen plans only.
