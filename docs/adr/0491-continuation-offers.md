# ADR 0491: Continuation offers: an address's, taken once by the person signed in as it

Status: accepted, 2026-11-22 (stage 32a, build step 4; [the spec](../stages/32-memberships.md),
"Today's course subscribers: the continuation", interview decision 7, stage 42's "Today's course
subscribers on the hosted platform"). Builds on ADRs
[0470](0470-the-import-door.md) (the import door),
[0485](0485-recurring-billing-the-provider-runs-the-schedule.md),
[0487](0487-the-payer-and-the-holder.md), [0489](0489-one-free-trial-per-person-per-plan.md) and
[0495](0495-the-courses-import.md) (people come first). Migration 0532. The free time and the
trial are [ADR 0492](0492-a-continuation-replaces-the-trial.md).

## Context
A company moving off another platform has people subscribed there, each paid up to a date. Cards
cannot be moved without both processors taking part (the spec, "Moving members' billing"), so
each person subscribes again on the new site, free until the date they have paid for, and the
company ends the old subscription at its period's end. The company needs to know exactly who has
done so. The gatekeeper already opens a page free until a moment (`trialEnd`, at least 48 hours
ahead, ADR 0485).

Free time is money: whoever takes an offer gets the plan free until its date. So who may take one,
how often, and who may make them are the questions here.

## Decision

**An offer is an address, its Person, a plan and a paid-up date** (`core_subscription_offer`,
migration 0532), with the other platform's reference when the source has one. One per address per
plan object: the address is the import's key.

**Only the person it is for takes it.** `subscription.start { plan, returnUrl, offerId }` takes an
offer only for a signed-in customer whose **account address is the offer's** and whose **Person is
the offer's**. Anyone else's offer is not found, whatever it is, so nobody learns who has one.
- **Never a guest who typed the address.** A guest's call with `offerId` is refused
  (`rule: "offer_sign_in"`) before anything is read: a typed address proves nothing (ADR 0489's
  reasoning for the trial), and otherwise a stranger could take someone's free time with their own
  card. The address is proved by its sign-in code (ADR 0458).
- **Never staff for someone.** Staff start a subscription by email (ADR 0485), but an offer
  carries free time for a particular person; taking one is that person's act. Refused the same way.
- **Never another address of the same Person, never transferable.** The offer is tied to the
  address the old platform knew. A Person with two addresses takes it signed in as that one. A
  person merge repoints the offer's Person to the survivor and keeps its address; if the
  survivor's account signs in under another address, staff import the offer again under it.
- `subscription.offer.mine` (customer, read) gives the signed-in customer their own offers they can
  still take, by the same two checks.

**Used once.** The provider's verified event that makes the subscription from a checkout opened
from the offer (`core_subscription_checkout.offer_id`) marks the offer taken by that subscription,
in the event's batch. A second take is refused (`offer_taken`).

**Two takes at once open one page.** A take writes, in its own batch, that the offer holds the
page it opened (`checkout_id`, its reference, address and expiry). Migration 0532's trigger refuses
holding a page for an offer that holds one, is taken or is withdrawn, so of two takes at once the
second one's whole batch fails (`offer_held`) and its page is never handed out. As for the trial
(ADR 0489):
- the same person taking it again while their page is open gets that page, with its terms;
- a held page is released only when the provider says it expired uncompleted
  (`getSubscriptionCheckout`); one it says was completed is taken; if the provider cannot be asked,
  nothing is opened now (`offer_unconfirmed`).

**Expires on its date; withdrawn by staff.** Once the paid-up date has passed it cannot be taken
(`offer_expired`): the person subscribes without it, charged at once (ADR 0492). Staff with
`subscriptions:manage` withdraw one not yet taken, with a reason (`subscription.offer.withdraw`, a
person only). A page already open from it can still be completed at the provider: the withdrawal
says so (`pageOpen`), and if it is completed the offer is marked taken and staff are told ("A
withdrawn continuation offer was taken"), to end its free time in the provider's dashboard if they
choose. Ending it from the host would be a charge the host decided on, which nothing here does.

**The import is a person's, on the import door.** `subscription.offer.import` (staff,
`subscriptions:manage`, `actors: ["human"]`, not on MCP, `bulk-write`, up to 50 rows a call) and
`cos subscriptions offers import <offers.csv> --plan <object>[:<id>]` (ADR 0470's run: a person
signed in for the run, a device session held in memory only):
- **The file:** a header naming `email` and `paid_up_to` (or `free_until`), and optionally
  `reference`; every problem named with its line before anyone signs in (not an address, not a
  date, an address twice).
- **A dry run first**, of every row; then the same rows written. `--dry-run` stops there.
- **People come first, and none is created** (ADR 0495's rule): an address must be the one live
  Person's who has it (`core_person_emails`, live); none is `unmatched`, more than one
  `several_people` ("merge them first"), each listed with its line. The rest import.
- **The address is the key** (per plan object). A re-run changes nothing; a changed date or
  reference updates an offer not yet taken; an offer taken, withdrawn, holding a page on the old
  date, or whose address is now another Person's is a **conflict**, reported and never
  overwritten.
- **A date is the start of that day in the organisation's time zone** (Settings → General), the day
  the old platform would have charged again; a full moment with its offset is itself. More than two
  years ahead is refused.
- **Signing in.** An imported person has no customer account. Under sign-up `open` they can sign
  in; under `invite_only` or `buyers` (they have bought nothing here) they cannot, unless invited.
  `--invite` (`invite: true`) invites each matched address in the import's batch, as
  `customer.invite` does, and needs `users:manage` as it does; the report says how many people can
  sign in only while sign-up is open. Nothing is emailed to anyone: the company tells its people.
  A separate change (not merged when this was built) adds the customer sign-in setting "anyone
  starting a subscription": any address may get a code while a plan is on sale, people already in
  the records included. With it on, imported subscribers sign in without invites. Nothing here
  depends on it, and taking an offer still needs the address proved by its code.

**The report.** `subscription.offer.list` (staff with `subscriptions:manage`, which its handler checks: a read carries a read permission, `records:read`) lists offers by
address with their status (taken, open, expired, withdrawn), a page held open, the subscription
that took it and **when it starts charging** (its free time's end, or its start when it was charged
at once), and, for one not taken, a running subscription the person started another way.
`subscription.offer.export` gives it as CSV (a cell a spreadsheet would read as a formula is
written as text). The admin's Subscriptions section has a Continuation offers view with both, and
withdraw; `cos subscriptions offers report` prints or saves the CSV. The company ends the old
subscription of everyone taken, at its period's end, and chases the rest before their date.

**Erasure and merge.** Erasing a Person deletes their offers (by Person and by address); a merge
repoints them (above).

## Consequences
- A company's moving subscribers each act once: sign in, continue, give a card. Some will not; the
  report says who, and their old subscriptions keep running until the company ends them.
- The price is the plan's price when the offer is taken, not what the old platform charged.
  A different price for movers would be another plan record.
- An offer gives free time to one proved person only; the import gives no one anything until they
  sign in as the address and give a card to the company's own provider account. Nothing charges a
  card the person did not give to it.
- Moving the first client's subscribers (its own export, its list, telling its people) is the
  client's own setup, outside this repository.

## Proof
`packages/core/test/subscription-offers.test.ts` (13 tests, against the payments gatekeeper's
test double), `packages/create-composable-os/test/offers-import.test.ts` (5: the file, its lines,
the dry run before the write, the report, stopping before sign-in),
`apps/app/test/offers-import.test.ts` (3: the CLI's engine over the real HTTP surface with a staff
device session, as the command runs it) and the courses e2e journey (an imported subscriber signs
in under `invite_only`, takes the offer, holds every course, is charged nothing until the date, and
staff see it taken; the real gatekeeper with its fake provider).

Each check removed, tests fail (restored after; tests of `subscription-offers.test.ts`):

| Check removed | Tests that failed |
| --- | --- |
| The take's address check (the Person's alone) | 1 (another address of the same Person) |
| A take is a signed-in customer's only | 1 (a guest and staff refused) |
| Migration 0532's one-page trigger | 1 (two takes at once) |
| A taken offer is refused | 1 (used once) |
| A withdrawn offer is refused | 1 (withdrawn) |
| An expired offer is refused | 1 (past the date) |
| The import is `actors: ["human"]` | 1 (no AI actor) |
| Inviting needs `users:manage` | 1 (the invite) |
| A dry run writes nothing | 1 (the import) |
| An address no one has is reported (not given an offer) | 1 (the import) |
