# ADR 0488: The `subscription` access source: what a running subscription gives its holder

Status: accepted, 2026-11-22 (stage 32a, build step 3; [the spec](../stages/32-memberships.md),
interview decision 4; stage 42's "Decided for stage 32": a course subscription covers every
published course, including ones added later). Builds on ADRs
[0477](0477-the-access-scope.md) (the access scope and `registerAccessSource`),
[0485](0485-recurring-billing-the-provider-runs-the-schedule.md) and
[0487](0487-the-payer-and-the-holder.md).

## Context
ADR 0477 built one question, `holdsAccess`, answered from the sources an object declares, and a
seam for kinds the host provides (`registerAccessSource`), proved with a fixture kind: "stage 32
adds `subscription` this way", with no change to the seam, the `holders` flag or `media.play`.
ADR 0485 made `core_subscription`, moved only from the provider's verified reads. The Courses pack
needs a course subscription that opens every course.

## Decision
**A host kind, registered like the fixture.** `packages/core/src/subscriptions/access.ts` calls
`registerAccessSource("subscription", { holders, problems })` when the subscriptions module loads.
`visibility/access.ts`, the `holders` flag and `media.play` are unchanged; stage 42's access tests
run unchanged.

**Declared on the object it opens:**
`{ kind: "subscription", options: { plans: "<ext>.<plan>", covers: "all" } }`.
- `plans` names another object of the same extension whose `sellable` declares `recurring` (a
  plan). Every record of it gives the access: a second plan record later covers the same. Another
  extension's plan cannot open this extension's records.
- `covers: "all"` (every live record of the object, including ones made later) is the only cover
  in 32a. A list of records is left for later; an unknown option or another cover is refused.
- The SDK's contract check refuses a bad declaration at `cos ext check` and install (it names this
  extension's own objects); the host's `problems` refuses it at runtime too, so a declaration that
  does not hold together gives no one access and says why (ADR 0477's rule).

**Who holds, and until when.** A customer holds every live record of the object when a
subscription to a plan of `plans` has them as its **holder** (never as its payer: ADR 0487, so a
parent paying for a child gives the child access in 32b, not themselves) and the host's record
says:
- `trialing`, `active` or `past_due`. Past due is a renewal the provider is retrying: the member
  keeps everything while it retries (decision 4), and loses it when the provider gives up, which
  the company's provider setting makes "cancel the subscription" (`ended`) or "mark unpaid";
- and, when it is set to end at its period's end (`cancel_at_period_end`) or on a date set at the
  provider (`cancel_at`), only before that moment. Access stops at the period's end and not a
  minute after, even while the provider's event saying it ended has not arrived.
- `incomplete`, `unpaid`, `paused`, `ended` and `expired` give nothing.

The rule reads the host's own record, which only verified events move (ADR 0485); it never asks
the provider, and the provider's own "entitlements" feature is not used.

## Consequences
- Courses declares it on `courses.course` with `courses.plan` (ADR 0490); `myCourses` says a course
  held with no enrolment of theirs is "through your subscription", from the host's answer.
- A subscription that is renewing (its period end has passed, the renewal invoice not yet paid)
  keeps access until the provider says it failed or ended: the host does not guess a lapse.
- 32b's memberships will grant a record instead (`recurring.grants`); this kind stays for plans
  whose access is read straight from the subscription.
