# ADR 0803: A birthday as day and month on Person

Status: accepted, 2026-11-24 (stage 53 build, step 7; decision 6 of the stage's spec). Builds on
ADRs [0402](0402-staff-and-customers.md) (a customer operation is a reviewed change),
[0413](0413-outside-handlers-have-no-raw-database.md) (`hostInternal` for what is not a record the seam reads),
[0540](0540-the-family-link.md) and [0590](0590-routine-mail.md) (value marks), and
[0800](0800-journeys-as-a-host-primitive.md) (journeys). Spec: [stage 53](../stages/53-journeys.md).
Migration 1171.

## Context

A birthday journey ("on the day, in the business's zone") needs a birthday on the Person. Until
now the host kept no date of birth on purpose: a minor is a dependant of a live family link or a
Person staff marked (stage 44), never an age worked out from a date. A birthday is new personal
data; the member may give it, staff may record it, and the assistant must not overwrite what a
member said.

## Decision

- **Day and month, nothing else.** `core_person.birth_day` and `birth_month` (migration 1171):
  both null or both set, a day the month has (29 February is one), enforced by a CHECK as well as
  by the operations' schema (`birthdaySchema`, `packages/core/src/journeys/birthday.ts`). No year
  is taken or stored, so a birthday never says how old someone is and never decides who is a
  minor.
- **Optional and set two ways.** `person.setBirthday` (staff, `records:write`, risk `write`;
  null removes it) and `me.birthday.set` (the signed-in member, for themselves only: the Person is
  the principal's, never an input). `me.birthday.get` lets My account show it. Both customer
  operations are `hostInternal`: the birthday is in no `rec_*` view, so the seam's customer fields
  cannot carry it; they read and write only the caller's own row, and the change is recorded as
  the host's for that caller (`recordHostChange`), marked `customer`.
- **A field like any other on the write path.** Every change is recorded under the field
  `birthday` (`{ day, month }` or null), so the audit diff, its value mark and the field registry
  entry follow the usual rules: a person's write is marked `person`, an AI's `ai`, the member's
  `customer`. `person.get` shows it to staff who may read the Person.
- **An AI may not change a birthday the member gave.** `person.setBirthday` refuses any actor
  but a person when the current value's mark is the member's (`customer`) for that value. Once a
  person on the staff has set it, or when none is recorded, an AI's write goes through the usual
  gate. `person.merge` holds to the same rule (after the review of PR #431): an AI's merge that
  would drop the duplicate's member-given birthday, or carry it to the survivor (where the copy's
  mark would be the AI's), is refused; only a person merges it.
- **A write over the value it read.** Every birthday write (`person.setBirthday`,
  `me.birthday.set`, a merge) carries a guard row (`core_birthday_guard`, migration 1171) holding
  the birthday it was planned from; the batch fails as a conflict (`core_birthday_changed`) when
  the birthday changed meanwhile, so the member's own, set while an AI's write was on its way, is
  never overwritten unseen.
- **Kept out of bulk paths.** No `rec_*` view has the columns, so no export, list filter, saved
  view or dashboard reads a birthday; `person.updateMany` and imports do not set it, and
  `person.update` refuses it, naming `person.setBirthday` (as `record.update` does).
- **Merge and erase.** A merge keeps the survivor's birthday unless it has none, then takes the
  duplicate's with the duplicate's mark (a copy keeps whoever gave it). Erase deletes it with the
  Person's row and its marks.
- **The entry rule.** `birthdaysOn(now, zone)` is the local day in the business's zone; on
  28 February of a year with no 29th it includes the 29th. `birthdayPeople(db, { now, zone })`
  returns the live People whose birthday it is, by id, a page of at most 500 at a time, one
  statement per page through `core_person_birthday_idx` (`birth_month`, `birth_day`, `id`, partial
  on live rows). A Person with no birthday is never found. Who of them a journey enters (its
  conditions, re-entry rule and exclusions) is the entry code's, and the daily scan that calls it
  is step 4's.

## Consequences

- A birthday journey enters only People with a birthday recorded, on their day in the business's
  zone, without reading every Person.
- The member's own word stands against the assistant; staff can still correct it.
- My account's Your details shows a day and a month to choose where the client holds
  `me.birthday.*` (the web and native blocks), and nothing where it does not.
- Not yet: the staff screen for it (the Person's Journeys tab, step 5), a birthday from a form
  (stage 29) and the scan that enters People on it (step 4).

## Alternatives rejected

- **A full date of birth.** It would let the host, and anyone reading the Person, work out ages
  and would compete with the family link and the Minor mark as the way a minor is known.
- **Through `person.update` and `me.update`.** The seam's customer fields read the `rec_person`
  view, which would then carry the birthday into exports and dashboards; a separate operation also
  lets the AI rule above live in one place.
- **A table of its own.** Two nullable columns on the Person, erased with the row, are simpler and
  need no merge code beyond the rule.
