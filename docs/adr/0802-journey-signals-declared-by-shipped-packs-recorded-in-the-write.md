# ADR 0802: Journey signals, declared by shipped packs and recorded in the write's batch

Status: accepted, 2026-11-24 (stage 53 build, step 2). Builds on ADRs
[0130](0130-automation-runtime.md) (bulk writes and `includeBulk`),
[0402](0402-staff-and-customers.md), [0404](0404-behaviours-are-the-vocabulary.md),
[0405](0405-skills-ship-with-the-platform.md),
[0425](0425-one-transition-engine-for-stages-and-states.md) and
[0590](0590-routine-mail.md) (value marks). Spec: [stage 53](../stages/53-journeys.md). The spec
numbered this decision 0801; the build took 0802, the number its step was given in block BO.

## Context

A journey (stage 53) starts and stops on what a Person did or stopped doing: a membership started,
a class attended, a trial ended. "Not seen for 14 days" is the absence of an attendance for 14
days, which a daily scan must find without reading every booking. Journeys are a host primitive,
not a pack and not automations, and a pack may not hook a write (ADR 0404). So the moments must be
declared by packs and recorded by the host, for every writer, cheaply enough to scan.

## Decision

**A shipped pack declares journey signals in its manifest** (`journeySignals`, a record of
`JourneySignalSpec`, `packages/sdk/src/journey-signals.ts`). Each names one of the pack's objects,
the relation field naming its Person (default: the object's customer field), and when it happens:
the record created (no `enters`), or entering one of the states in `enters`, optionally only from
the states in `from`; a record created straight into an `enters` state counts unless
`created: false`. A signal's id is `<extension>.<name>`. The contract check refuses an unknown
object, a Person field that is not a relation to one person, a state the object does not have,
`from` without `enters`, more than 12, and a signal no declared way into a state can make: no
move (`moves`, timed `after` moves and `follows`) into an `enters` state from a `from` state, and
no create into one (`initial`, `create.in`) where creates count; and a `from` state no move leaves
for an `enters` one. **A runtime extension
may not declare one** (the install check, `outside_audience`, as routine mail): a signal starts
journeys that mail members.

The first declarations: Memberships `started` (a membership created, on trial or paid),
`joined` (from `trialing` to `active`: a trial becoming paid; a payment caught up or a pause ended
is not joining), `ended`, `trialEnded` (leaving `trialing` for anything but `active`: joining is
not a trial ended) and `passStarted` (a pass created, bought or given); Bookings `booked` (created booked, or from
`pending` or `waiting`: a tick taken back is not a new booking) and `attended`; Ticketing
`ticketBought` and `checkedIn` (from `valid`).

**The host records them in the write's own batch, from the pipeline.** The reconciler puts each
object's signals, resolved, on its registry definition. Beside the value marks, the staff and the
customer pipelines hand every write's recorded changes to `signalStatements`
(`packages/core/src/journeys/signals.ts`), which adds one upsert to the batch:
`core_person_signal` (migration 1175) keeps one row per Person and signal, the last time, the record
that made it, the write's **standing** as its marks say it (`person`, `customer`, `public`, `host`,
`ai`: an AI's write, or one only the adjudicator approved, is `ai`; a person's approval of it is
`person`) and whether the operation was a **bulk** one: the rule automations' `includeBulk` uses
(`isBulkOperation`: more than one record, a `…Many` or an `import.*` operation), and any operation
whose risk is `bulk-write` whatever its size, so the last chunk of an import, one record, is bulk
too (the review of PR #371; automations' rule still misses that case). An earlier time never replaces a later one. Every path that records a change
records its signals: `record.create` and `record.update`, imports and `createMany`, the host's own
moves through the transition engine (a membership following its subscription, a booking promoted
from the waitlist, a tool's write). An approval queue's dry run records nothing. The statement
carries its rows in one JSON parameter, so a batch of any size costs one statement of four bound
values more than its write (D1 allows 1,000 statements and 100 bound values).

**Privacy.** Signals are a visit history by another name. They are in no `rec_*` view, export or
dashboard; erase and the Trash's purge delete a Person's rows; a merge moves the duplicate's to the
survivor, keeping the later of each. A signal a pack stops declaring loses its rows at the
reconcile, and a dropped object's rows go with its table.

## Considered and rejected

- **Recording in the transition engine and `createRecord`.** The spec named those places; the
  pipeline's recorded changes are the same writes, with the standing and the bulk flag the engine
  does not know, and reach every path without a second hook in each caller.
- **One row per occurrence.** A history of every visit would grow without bound and is not what a
  journey asks ("when did they last"); the record that made the latest is kept for the message's
  slots.
- **A pack recording its own signals in a tool or an automation.** It would miss every other
  writer, and a pack may not hook writes (ADR 0404).
- **Letting a runtime extension declare signals.** What starts journeys to members is a reviewed
  declaration, as routine mail is.

## Consequences

- Step 3 (journeys, entries) and step 4 (the engine's entry by signal, the quiet scan over the
  (signal, last_at) index, exits) read `core_person_signal`; nothing reads it yet.
- A new pack that a business follows up on declares its signals in its manifest; the write-extension
  skill says how.
- A write that moves many records into a signal's state adds one statement to its batch however many
  it moves.
- For step 4 (the review of PR #371): `last_at` is when the write happened, not when the thing did
  (a tick for a class weeks ago, or a tick taken back and given again, records now); a later write of
  the same signal replaces the row, so an entry the tick has not made yet from the earlier one is
  made from the later one's standing and bulk flag; and a host write that follows another's (a
  waiter promoted when an AI cancels a booking) stands as the host's, not as the root write's. The
  engine decides whether the root's standing must travel with the signal.
