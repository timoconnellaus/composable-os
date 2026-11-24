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
objects of it, and the check cannot tell whether they exist. They are checked at this extension's
next install or upgrade made while the other is installed: then a misspelt object of it is unknown
as usual. Installing the other extension does not check again the extensions that wait for it.
What a person sees instead is below ("Listed as broken"). `cos ext check` installs the named
extensions from the directories beside it first (as for `requires` and objects it names), so a
pack in `packs/` is checked against them in CI; the exposure is an extension written in the
workspace, or checked without the other beside it.

**It waits until they are installed and on.** Nothing is stored for the wait: the host reads it
when it would start a run. `waitingFor(spec, active)` (`packages/core/src/automations/registry.ts`)
is the extensions of `onlyWith` that are not `active` in `core_extensions`. While it is not empty
the automation starts no new run: not from trigger matching or the cron
(`loadEnabledAutomations`), a manual start from a button or a list (`automation.run`), a retry or
a replay (`automation.retry`, `automation.replay`, refused with words, and by the runner too), or
the drain of runs held back by the runs-per-minute rail
([ADR 0573](0573-runs-over-the-rate-rail-wait-their-turn.md)), which stay queued and are counted
as waiting. The read is one query of `core_extensions` by primary key, made only when a matched
automation names `onlyWith`, so automations without it cost nothing more. It runs again the
moment the other extension is installed or enabled, and waits again while it is disabled or
quarantined. A run already started carries on (see Consequences).

**Listed as waiting.** `automation.list` and `automation.get` show status `waiting` and
`waitingFor` (the ids) for such an automation; a manual one is not offered as a button while it
waits. A person's on or off is kept: a disabled automation shows `disabled`; enabling one that
waits leaves it `waiting`.

**Listed as broken.** Once every extension it runs only with is installed and on, the list reads
what the automation names of them (its trigger object, its steps' reads and writes, and its
extension's `permissions.read` / `write`) against the schema registry. Any that does not exist is
in `unknownObjects`, and the status is `broken` ("Needs a fix" on the automations screens, with
the objects): its extension must be corrected and installed again, which checks it in full. The
runtime is not gated on it (the dispatch path does not read the schema registry, and a stale one
would hold back a sound automation): a trigger on an object that does not exist never fires, and a
step calling one fails and is recorded in the run.

## Consequences
- Reviews can ship one pack for gyms and trades; its "after the Nth class" automation is off,
  and says why, for a business without Bookings.
- Field checks of another extension's object (a trigger's field, a condition) were, and stay, made
  only where the host is given that object's fields (the SDK's `objectFields`); a deployment's
  check does not pass them today. `onlyWith` does not change that.
- A run already in progress when the other extension is disabled carries on, including one woken
  by an approval; its calls into that extension fail and the run records it.
- Amended 2026-11-24 (review of PR #420): the first draft said a misspelt object is checked once
  the other extension is installed, and did not refuse retry and replay. Neither held; the
  decision above now says what is checked when, adds `broken`, and refuses retry and replay.

## Rejected
- **A companion pack** (`reviews-bookings`): a second install for one automation, and the stage's
  own decision.
- **`requires` with an "optional" flag on the extension**: the need is one automation's, and
  tools, views and screens that named the optional extension would each need the same rule.
- **Pausing the automation (`paused_reason`) at install and clearing it on the other's install**:
  every change of any extension's status would have to find and update the automations that wait
  for it, and a person's "enable" would clear the pause while the extension is still missing.
