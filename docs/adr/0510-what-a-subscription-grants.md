# ADR 0510: What a subscription grants, kept in step with it (`sellable.recurring.grants`)

Status: accepted, 2026-11-22 (stage 32b, build step 6). Builds on ADRs
[0435](0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md),
[0485](0485-recurring-billing-the-provider-runs-the-schedule.md),
[0487](0487-the-payer-and-the-holder.md), [0488](0488-the-subscription-access-source.md) and
[0493](0493-the-allowance-behaviour.md). Migration 0580.

## Context
32a left a hook for 32b: "a subscription may grant a record of the plan's pack". Courses does not
use it (its access reads the subscription itself, ADR 0488), but a gym membership must be a record:
it is an allowance holder that a booking spends, with its own uses per week, its class types and
its dates. That record must exist exactly while the subscription gives something and say so: on
trial, active, past due while the provider retries (decision 4), paused, ended. Only verified
provider events move a subscription (ADR 0485), and no extension code may hook a write (ADR 0404),
so following it is the host's.

**The name.** Stage 31 added a behaviour called `recurring` (ADR 0500): a weekly timetable rule
that makes classes ahead. This hook is the plan's own `sellable.recurring` (a plan paid every
period, ADR 0485), which only shares the word. To keep them apart, the documents always say
`sellable.recurring.grants` (or "what a subscription grants"), never "the recurring behaviour", and
CONTEXT.md's Series entry and Subscription plan entry each warn of the other.

## Decision
**The declaration**, on the plan object: `sellable.recurring.grants: { object, set, from?, until?,
states }`.
- `object`: another of the extension's objects, with `states` and no `owner`.
- `set`: fields filled once, when it is granted: `item` (a relation to the plan), `item.<field>`
  (the plan's terms as they are at the start), `subscription` (a text field, its id),
  `subscription.holder` and `subscription.payer` (relations to person). The holder always has a
  value; the payer never fills a required field.
- `from`, `until`: datetime fields the host keeps (a moment, not a day: access stops at the
  period's end and not a minute after).
- `states`: for each subscription state that grants (`trialing`, `active`, `past_due`, `unpaid`,
  `paused`, `ended`) the granted object's state. `ended`'s must be final; the initial state must be
  one of them; the granted object needs a host move from each mapped state to each other one,
  since the provider's reads come in any order.
The SDK's contract check (`checkRecurringGrants`) refuses what could fail the event's batch, as
`checkGrants` does for an order line's.

**Following it** (`subscriptions/grants.ts`), called by the subscription events in the batch of
every verified read that makes or moves a subscription, after its row is written:
- **Granted** when the first read reports it running (any state but `incomplete` and `expired`):
  one record, created by the host in the mapped state, with `from` the period's start; and a
  `core_subscription_grant` row keyed on the subscription, so two events applied at once cannot
  grant twice (the second batch fails whole; the provider delivers again). A subscription that
  never ran grants nothing; one with no holder tells staff and grants nothing.
- **Moved** with every later read: the mapped state, and `until`, the earliest of the moment it
  ended, its period's end when set to end at it, a `cancel_at` date, and 30 days of failing while
  past due (`PAST_DUE_GRACE_DAYS`, ADR 0488's access rule); a running one with none clears it. A
  granted record in a final state, or in the Trash, is left alone.
- **Nothing else changes it**: the plan's terms are copied at the start (plan changes are the next
  step). The allowance needs no new rule: its `live` states and `until` already refuse a spend
  past the end, and past due spends until its 30 days run out.

**Payer and holder.** The granted record is the holder's (ADR 0487): a parent paying for a child's
membership gives the child the membership and its uses, the parent the billing. `subscription.start`
gains `holderPersonId` for staff only (a live Person); a customer naming one is refused (`rule:
"holder"`). The trial is decided for the holder, as before. The customer-facing "buy for my child"
waits for stage 31's family link: when it lands, `holderFor` (the one place that decides the
holder) allows a customer to name a dependant the link shows, and nothing else changes.

## Consequences
- A dropped granted object's grant rows go with it (the reconciler); the subscriptions stay.
- A person merge needs nothing new: the membership's person relation is repointed by the merge,
  the subscription's holder by ADR 0487's amendment, the allowance's terms by ADR 0494.
- The membership's `until` is written by the event that sets the end, so a membership set to end
  stops giving at the period's end even if the provider's final event is late, as access does.

## Not done
- Plan changes and pauses (the next build step) will update the granted record's terms and its
  `paused` state through the same function.

## Note (2026-11-22, stage 32b plan changes and pauses)
Built as said: a plan change that takes effect writes every field the grant fills from the plan
again (`followSubscriptionGrant`'s `planChanged`, [ADR 0530](0530-plan-changes-upgrade-now-downgrade-next-period.md)),
and a pause is the subscription's `paused` state mapped as before ([ADR
0531](0531-staff-pause-a-membership-for-a-set-time.md)). "The plan's terms are copied at the
start" now reads: at the start, and again when a plan change takes effect.
