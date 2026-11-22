# ADR 0489: One free trial per Person per plan object, for a proved holder, used when the provider confirms it

Status: accepted, 2026-11-22 (stage 32a, build step 3; stage 42's decision "one trial per Person";
the spec's guess "per plan object"). Builds on ADRs
[0485](0485-recurring-billing-the-provider-runs-the-schedule.md) and
[0487](0487-the-payer-and-the-holder.md). Migration 0531.

## Context
A course plan has a 7-day free trial: the card is taken at the start and charged when the trial
ends. The rule is one trial per Person. Until this step `subscription.start` gave a plan's trial
every time. Three ways it could go wrong had to be closed: a person getting a second trial by
opening two pages at once; a trial counted when a page is merely opened (so abandoning a page, or
someone else opening one, spends it); and a guest typing someone else's email address, which
makes the subscription that address's Person's.

## Decision
**Per holder, per plan object.** A holder who has had a trial on any record of a plan object gets
none on any record of it again (a second course plan later gives no second trial). The holder is
the payer in 32a (ADR 0487).

**Only a proved holder gets a trial.** A signed-in customer starting their own subscription, or
staff starting one for a Person by email. A guest who only typed an address is charged from the
start (`noTrial: "sign_in"`), and the subscribe block says to sign in for the trial. Why:
- a trial on a guest's start would be the address's Person's: a guest could spend someone else's
  trial by completing the page with their own card;
- the provider's page would show a trial or not depending on whether that Person had one, which
  tells a stranger something about them. A guest's answer is the same for every address.
A company that wants new visitors to try a plan turns customer sign-up to `open` (or invites
them): signing in proves the address by an emailed code (ADR 0458).

**Used when the provider confirms it, not when a page is opened.** The verified event that makes
(or moves) a subscription whose read has a trial on it marks the holder's trial used, in that
event's batch. A page opened and given up does not use it.

**Held while a page can be completed, so two starts give one trial.** A checkout opened with a trial
writes a hold (`core_subscription_trial`: holder, plan object, the page, `held_until` = the page's
expiry plus 15 minutes for its confirmation to arrive) in the start's own batch. Migration 0531's
trigger refuses a second hold for the same holder and plan object while one is live or the trial is
used: of two starts at once, the second one's whole batch fails (nothing of it is recorded; its
caller is told to start again) and its provider page is never handed out. The same holder starting
the same plan again while their page is open gets that page back, not a second one. Another plan
record of the object while a page is open is refused until it expires.

**What the hold cannot stop is told to staff.** A confirmation that arrives after its hold lapsed
(the provider's webhook delayed past 15 minutes, and the person started again meanwhile) can
confirm a second trial: the provider has already given it. The host marks it, tells staff ("A
second free trial was confirmed"), and staff end the trial in the provider's dashboard if they
choose. Ending it from the host would be a charge the host decided on, which nothing here does.

## Consequences
- `subscription.start` answers `noTrial: "sign_in" | "used" | null`. With `used`, the provider's
  page asks for the first payment at once (no trial is sent).
- A guest pays from the start for a plan with a trial: the block offers signing in first.
- Step 4's continuation offers give a free period until a date (`trialEnd`), which is not this
  trial; whether taking one counts as the trial is step 4's to decide. As built, any subscription
  the provider confirmed with a trial end counts as the holder's trial (and a second one tells
  staff), so step 4 must say otherwise for continuations if it means to.
- Staff can still start a trial for a Person who has not had one; staff are trusted with that.
