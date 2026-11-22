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

## Amended after review (2026-11-22)
Before the branch was merged, a review found what follows; each is changed above or here, with a
test that fails without it (`packages/core/test/subscription-access.test.ts`).
- **A hold is released only on the provider's word.** A lapsed hold no longer gives the trial back
  by itself. Before a start is given the trial, the host asks the gatekeeper about every
  unreleased hold of the holder on the plan object (`getSubscriptionCheckout`, a new observation:
  Stripe's Checkout Session `status`, the fake's ledger). `expired` releases it (`released_at`);
  `complete` marks the trial used, even before its confirmation arrives; `open` keeps it held. If
  the provider cannot be asked, no trial is given now (`noTrial: "unconfirmed"`, the caller is told
  why). The trigger now refuses a hold while another is unreleased, not only while it is live.
- **A page goes back only to whoever opened it**, with the terms it was opened with (the hold keeps
  its price and trial days and who opened it), and only while the provider says it is open.
  Anyone else, staff included, gets a fresh page with no trial (`noTrial: "held"`); another plan
  record of the object while a page is open is the same, no longer a refusal.
- **Staff give a trial only with `subscriptions:manage`, as a person.** Staff with `records:write`
  alone, or a call that is not a person's (an automation), start without one
  (`noTrial: "permission"`) and hold nothing.
- **A merge moves the trial** (ADR 0487): the merged Person's trial rows become the survivor's;
  where both had one on a plan object, one is kept (the earliest used, else the earliest hold).
- **A malformed expiry** from the gatekeeper is never thrown on after the page is opened: the
  gatekeeper validates it, and the host reads it defensively (a page with none is held for a day).

## Decided by the owner (2026-11-22)
- **A new visitor gets the trial by confirming their email with a code first**: a new customer
  sign-in setting, "anyone starting a subscription", set by a human admin like the existing modes
  (ADR 0458). Not built here: a later identity session builds it. Until then a guest gets no
  trial, and the subscribe block's `noTrial: "sign_in"` notice (its "Sign in for the free trial"
  button, `onSignInForTrial` or `signInUrl`) is where that flow joins.
- **A continuation's free time is not the trial.** Only a subscription opened with the plan's
  trial days uses it (`useTrial` and `trialUsed` read the checkout's `trial_days`); a free time
  until a date (`trialEnd`, step 4) writes no trial row, uses nothing and tells no one of a second
  trial. Tested with a checkout as step 4 will write it. The Consequences above saying any
  confirmed trial end counts are superseded.

## Amended (2026-11-22, build step 4)
Continuation offers are built ([ADR 0491](0491-continuation-offers.md),
[ADR 0492](0492-a-continuation-replaces-the-trial.md)). As decided above, taking one writes no
trial row and uses nothing. One more reason a trial is not given: `continuation`, while the holder
has an offer on the plan object they can still take, or a subscription started from one that has
not ended: no trial stacked onto the continuation. After it (the subscription ended, or the offer
expired untaken) this ADR's rule applies unchanged: a trial once, if never had (ADR 0492).

## Note (2026-11-22, ADR 0459)
Built: "anyone starting a subscription" is a switch on top of the customer sign-up mode
([ADR 0459](0459-anyone-starting-a-subscription.md)). With it on and a plan on sale to the public,
a new visitor confirms their address with a code on the plan (the subscribe block's `signIn`) and
starts it signed in, so the trial rule above applies unchanged: one trial per Person per plan
object, which is one per confirmed address until staff merge two People. "A company that wants new
visitors to try a plan turns customer sign-up to `open`" above is superseded by this switch.
