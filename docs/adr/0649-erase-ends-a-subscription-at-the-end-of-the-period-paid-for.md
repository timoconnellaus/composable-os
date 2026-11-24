# ADR 0649: Erase ends a subscription at the end of the period paid for

Status: accepted, 2026-11-24 (issue #293). Applies stage 48's decision 1
(`docs/stages/48-my-account.md`, the owner's interview of 2026-11-24) to erase. Amends
[ADR 0646](0646-erase-merge-and-retention-for-agreements.md) (which left a running subscription
billing after erase) and narrows its round 2 note "a purchase belonging to another identified
Person is left entirely alone" for running subscriptions. Builds on
[ADR 0485](0485-recurring-billing-the-provider-runs-the-schedule.md) (the provider runs the
schedule) and [ADR 0487](0487-the-payer-and-the-holder.md) (the payer and the holder). No migration.

## Context
Erasing a Person never touched their subscriptions at the provider. One whose payer was erased kept
charging the card, the holder kept what it granted, and only the erased payer's address was cleared
(ADR 0646). A checkout the provider confirmed after the erase made nothing, and staff were told to
cancel and refund it with the provider by hand.

Stage 48's interview settled the member's own deletion: "Deleting an account stops a monthly
membership they pay at the end of the period already paid for. Nothing is refunded. This is what
cancelling does today." It left open what erase does to a subscription still running: an erase
staff start without the member deleting, a subscription someone else pays, and one resumed since
the deletion set it to end.

## Decision
**The same rule, for every subscription an erased Person is on.** `person.erase`
(`subscriptions/erase.ts`, `endErasedSubscriptions`) finds every subscription whose payer or holder
is the erased Person (or anyone merged into them) and that has not ended, and asks the provider
through the payments gatekeeper (`cancelSubscription`, the host's own call):

- **still running** (`trialing`, `active`, `past_due`): to end when the period already paid for
  ends (`period_end`). What it gives lasts until then; nothing is refunded and nothing more is
  charged. One already set to end at the period's end, or on a provider date on or before it, is
  not asked; one with a later provider date is asked for the period's end.
- **its paid period already over** (`paused`, `unpaid`, `incomplete`): to end at once (`now`),
  which charges nothing and refunds nothing either.

So the three open cases fall out of one rule: an erase staff start ends them whether or not the
member deleted their account; a subscription someone else pays (the erased Person is its holder)
ends, and so does one the erased Person pays for someone else; one resumed since a deletion set it
to end is asked again, because erase reads its state at the time.

**When it asks.** After the rest of the erase has queued (nothing else of it can refuse) and
before the commit, which clears the payer and holder (ON DELETE SET NULL), as `subscription.cancel`
asks inside its handler. The record moves only when the provider's verified event says so, and it
still can: events find a subscription by its own id, not by who is on it. A simulated erase asks
nothing.

**When it cannot ask** (no payments connection, a different provider, the gatekeeper refused or
did not answer), the erase still happens: a person's erasure is never held up by a payments
outage. The admins are told in the erase's batch which subscriptions they must end themselves
(`subscription.cancel`, or with the provider); the notice links the first and lists the ids,
naming nobody.

**Another live Person on it** (a guardian paying for a child, or a child someone pays for): the
admins are told, naming nobody, that it ends at the period's end and that a new subscription keeps
it going for the other person. One notice per kind per erase, so the statements stay bounded by the
number of admins.

**`person.erase` says what it asked:** `subscriptionsEnding { atPeriodEnd, now, leftForStaff }`.

**A checkout the provider confirms after the erase** (`subscriptions/events.ts`) still makes
nothing; the host now asks the provider to end it by the same rule, on that event and on any later
event whose read does not yet show it ending. Staff are told once (the existing notice) that it was
asked to end, or that they must cancel it if it could not be asked. Nothing is refunded by the
host; the notice says a refund of the first payment is the business's to give with the provider,
only if it owes it.

**Not changed:** a pass or ticket order paid after erase cancelled it stays on the paid-late list
for staff to refund (a drop-in is still owed back automatically, ADR 0429). That is a payment for
something the host will never deliver, not a period already paid for, so the "nothing refunded"
rule does not apply to it.

## Consequences
- No erased Person's subscription keeps charging past the period already paid for, unless the
  provider could not be asked, and then the admins are told.
- The holder of a subscription whose payer is erased keeps what it grants until the period's end,
  then loses it; the payer of one whose holder is erased pays nothing more after it.
- A provider call that succeeded before a batch that then failed leaves the subscription set to
  end with the Person not erased. The member asked to be erased (or staff decided to), so ending
  their subscription is what was meant; erasing again asks nothing more once the provider's event
  shows it ending.
- Stage 48 step 6 (the member's own deletion) still sets their subscriptions to end before the
  erase request opens, as its spec says; erase does the same later for whatever is still running.
- Each erase makes one gatekeeper call per subscription to end. A Person is on a handful at most;
  there is no cap.
