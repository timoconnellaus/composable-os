# ADR 0812: An automation that runs only with another pack (`onlyWith`)

Status: accepted, 2026-11-24 (stage 54, build step 3, platform piece P3). Builds on ADRs
[0130](0130-automation-runtime.md) (the registry), [0246](0246-leads-as-an-extension-and-assignment-rules-in-core.md)
(an automation shipped off) and [0478](0478-the-courses-pack.md) (`requires`).

## Context
The Reviews pack (stage 54) asks a gym member for a review after their tenth attended class: an
automation on `bookings.booking`'s state. Everything else in the pack (asking by hand, the answer,
approval, the wall) works for a business with no timetable, a trade, which never installs
Bookings. `requires` is all or nothing (ADR 0478): requiring Bookings for one automation would make
every trade install a timetable, and a `reviews-bookings` companion pack would be a second pack to
install for one automation. Until now an automation could not even name another extension's
object unless that extension was installed when it was checked.

## Decision

**`onlyWith` on an automation.** `defineAutomation({ onlyWith: ["bookings"], ... })` names, by id,
the other extensions this one automation needs (at most five). The contract refuses its own
extension, an id twice, and one the extension already `requires` (always installed, so it says
nothing).

**It installs without them.** While an extension named in an automation's `onlyWith` is not
installed (no object of it is known to the check), that automation's trigger object, the objects
its steps read and write, and the extension's `permissions.read` / `permissions.write` may name
objects of it: they are checked once it is installed, as any other extension's objects are. Once it
is installed, a misspelt object of it is unknown as usual. `cos ext check` installs the named
extensions from the directories beside it first (as for `requires` and objects it names), so a
pack in `packs/` is checked against them.

**It waits until they are installed and on.** Nothing is stored for the wait: the host reads it
when it would start a run. `waitingFor(spec, active)` (`packages/core/src/automations/registry.ts`)
is the extensions of `onlyWith` that are not `active` in `core_extensions`; while it is not empty
the automation starts no run, on every path that starts one: trigger matching and the cron
(`loadEnabledAutomations`), a manual start from a button or a list (`automation.run`), and runs
held back by the runs-per-minute rail ([ADR 0573](0573-runs-over-the-rate-rail-wait-their-turn.md)), which stay queued. The read is one query of
`core_extensions` by primary key, made only when a matched automation names `onlyWith`, so
automations without it cost nothing more. It runs again the moment the other extension is
installed or enabled, and waits again while it is disabled or quarantined.

**Listed as waiting.** `automation.list` and `automation.get` show status `waiting` and
`waitingFor` (the ids) for such an automation; a manual one is not offered as a button while it
waits. A person's on or off is kept: a disabled automation shows `disabled`; enabling one that
waits leaves it `waiting`. Retrying or replaying a run is not refused (as for a disabled
automation); the run's calls into the missing extension fail as calls to it would.

## Consequences
- Reviews can ship one pack for gyms and trades; its "after the Nth class" automation is off,
  and says why, for a business without Bookings.
- Field checks of another extension's object (a trigger's field, a condition) were, and stay, made
  only where the host is given that object's fields (the SDK's `objectFields`); a deployment's
  check does not pass them today. `onlyWith` does not change that.
- A run already in progress when the other extension is disabled carries on; its calls into that
  extension fail and the run records it.

## Rejected
- **A companion pack** (`reviews-bookings`): a second install for one automation, and the stage's
  own decision.
- **`requires` with an "optional" flag on the extension**: the need is one automation's, and
  tools, views and screens that named the optional extension would each need the same rule.
- **Pausing the automation (`paused_reason`) at install and clearing it on the other's install**:
  every change of any extension's status would have to find and update the automations that wait
  for it, and a person's "enable" would clear the pause while the extension is still missing.
