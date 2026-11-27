# ADR 0511: The Memberships pack: plans, memberships, pass types and passes

Status: accepted, 2026-11-22 (stage 32b, build step 6). Builds on ADRs
[0435](0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md),
[0478](0478-the-courses-pack.md), [0490](0490-the-course-plan-self-service-and-the-staff-side.md),
[0493](0493-the-allowance-behaviour.md), [0494](0494-which-holder-pays-and-what-happens-to-uses.md)
and [0510](0510-what-a-subscription-grants.md). Stage 32's decisions 8, 9, 11 and 13.

## Context
A gym sells memberships paid every month (unlimited, or N classes a week or month, of some class
types or times) and passes bought once (a class pack of N that expires, a drop-in, an intro offer
once per person). Each is something a member holds and a booking spends (stage 31). The pack is laid
out as Courses is: objects with behaviours, tools that ask the host, hooks, web blocks and a
read-only native block.

## Decision
**Objects** (the spec's ids):
- `memberships.plan`: title, a line on what it gives, description, price per month, classes per
  period (empty: unlimited), per week or month, class types (Programs' `programs.classtype`, so the
  pack requires Programs), weekdays and a time of day (minutes after local midnight), trial days,
  status (`draft`, `on_sale`, `retired`). Public while on sale. `sellable` with `recurring:
  { interval: "month", trialDays }` and `grants` a membership (ADR 0510).
- `memberships.membership`: its Person (the holder), its payer, plan, subscription, the plan's
  terms as at the start, `from`, `until`, and a state the host moves with the subscription
  (`trialing`, `active`, `past_due`, `unpaid`, `paused`, `ended`). `customer: person`. An allowance
  holder, live while on trial, active or past due, and the only object that declares
  `emptyIsUnlimited`.
- `memberships.passtype`: title, price, classes, valid for N days (empty: no expiry), the same
  limits, an intro-offer flag, status. Public while on sale. `sellable` (one-off), granting a pass,
  one per Person while the flag is on (ADR 0512).
- `memberships.pass`: its Person, pass type, order, classes, the limits, `from`, `until` (when it was
  bought plus the type's days), where it came from (bought or given by staff), a reason, and a state
  (`active`, `void`). `customer: person`. An allowance holder over `total`, live while active.

**Every term of a membership or a pass is read-only**: only the host (a grant, a subscription's
event) and the pack's own tools write it. Staff using the generic record operations, an MCP client
and the assistant cannot set a member's uses or dates. The state field cannot be read-only (the
moves say who changes it): the membership's moves are all the host's; a pass's void move is the
host's (a refund) and staff's.

**A pass's expiry is the host's: `grants.valid`** (a platform addition to `sellable.grants`):
`{ from?, until?, days?: "item.<number field>" }` names the granted object's date fields; the host
writes `from` as the moment it is granted and `until` as that plus the item's days in local days of
the organisation's zone (a datetime: the same time of day; a date: the day before, since a date
includes its day). No days: no `until`.

**A drop-in is a pass of one** (the spec's guess): no object of its own. **No `used` or `expired`
state**: a pass's count and `until` already say it, and moving one would need a clock or a hook;
the tools and blocks say "none left" or "ended" from the host's numbers.

**Spent by stage 31's bookings**: each holder's `spendsOn` is `bookings.booking`, with conditions on
the fields the Bookings pack's host fills: `classType in classTypes`, `weekday in weekdays`,
`minute atLeast fromMinute`, `minute below untilMinute`. The booking declares `paidBy` naming this
pack. Until it exists, the pack's spend is tested against a fixture spender with those ids
(`packs/memberships/test/fixtures/bookings`).

**Tools** (each asks the host; none holds a rule):
- `plans`, `passTypes` (customer, public; read): what is on sale, with the host's currency;
- `buy` (customer, public; write): `order.start` for one pass (a guest gives an email; an intro
  offer is refused to a guest by the host);
- `mine` (customer; read): the member's own memberships and passes with `allowance.get`'s count;
- `holdings` (staff; read): a Person's;
- `givePass`, `voidPass` (staff; write; `permission: "memberships:passes"`, grantable;
  `humanOnly`, ADR 0512): give a pass from a type's terms (or fewer uses or days), free, with a
  reason and who gave it; void one staff gave (a bought one is voided by refunding its order).

**The member's side** reuses 32a's flows: `subscription.start` (the trial for a signed-in member,
or after a code on the plan), `subscription.list`, `.cancel`, `.resume`, `.portal`. Web blocks:
`memberships-plans`, `memberships-passes`, `memberships-mine`; staff: `memberships-staff-holdings`;
native: `memberships-native-mine`, read only (`noPurchase`; the block lint's purchase pattern now
covers every `useBuy…` hook).

**Staff side**: lists and saved views (active members, on trial, past due, ending this month, passes
expiring this month), a Person's Memberships and Passes tabs, the void button on a pass, the staff
holdings block, and the admin's Subscriptions section for billing (ADR 0490).

**Tax**: both sellables declare the provider's gym dues code (`txcd_50021001`), taxed only once a
human admin turns tax on. Whether the provider needs the gym's address as the place (as event
admission does) is an open check for the test-mode runbook.

## Consequences
- The pack is a new npm package (`@composable-os/pack-memberships`); the owner publishes it once by
  hand and adds its trusted publisher before the first release that carries it
  (docs/deploying.md, "Publishing to npm").
- The plan's interval is a month for every plan: a fortnightly membership needs `recurring.interval`
  from a field, a platform change for later.
- A guardian's read of a child's memberships and passes waits for stage 31's family link;
  `allowance.get` follows the seam, so it needs no change then.

## Not done here
Plan changes and pauses, the Memberships dashboard and the rest of the Person tab, `cos memberships
import` and the subscription import (steps 7 and 8).

## Note (2026-11-22, stage 32b steps 6 and 7)
Plan changes and pauses are [ADR 0530](0530-plan-changes-upgrade-now-downgrade-next-period.md) and
[ADR 0531](0531-staff-pause-a-membership-for-a-set-time.md): the plan gains `pauseMinDays` and
`pauseMaxDays` (`sellable.recurring.pause`). The dashboard, the new views and the blocks' plan
change and pause are [ADR 0532](0532-the-memberships-dashboard-and-staff-side.md). The import
(step 8) is still to come.

## Amended 2026-11-27 (stage 78, ADR 0980): Memberships requires Bookings only

A plan's, a pass type's, a membership's and a pass's `classTypes` relate to Bookings'
`bookings.classtype` (ADR [0980](0980-general-and-domain-packs.md)), so Memberships no longer
requires Programs: `requires: ["bookings"]`, which it needed already for `services`. The test
fixture spender (`packs/memberships/test/fixtures/bookings`) declares its own `classtype` the same
way. Whether Memberships should stand without Bookings is open (stage 78, questions for the owner).
