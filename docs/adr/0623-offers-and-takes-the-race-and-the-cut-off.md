# ADR 0623: Offers and takes: the race and the cut-off

Status: accepted, 2026-11-23 (stage 45, build step 3). Builds on ADRs
[0621](0621-the-staffed-behaviour-and-the-time-claim.md) (`staffed` and the time claim),
[0622](0622-warnings-in-a-writes-answer.md) (warnings; qualifications and unavailability as core),
[0620](0620-field-level-exceptions-in-recurring.md) (field exceptions) and
[0437](0437-a-move-is-made-from-a-current-read.md) (a move answers who moved it first).

## Context
Decisions 4 to 6 and 21 of stage 45's interview: staff offer a shift they cannot work; another
qualified person takes it without anybody approving; the manager is told; an offer can be made and
taken until an hour before the shift. Twenty people may press "take" at once, and a rosterer may
reassign the shift at the same moment. A read before the write is not a guarantee.

## Decision
- **An offer is a core row** (`core_staff_offer`, migration 0812): the shift (object, record), from
  (the shift's person, or none for an uncovered shift a rosterer offers), who made it, to (one
  named person, or everyone eligible), state (`open`, `taken`, `withdrawn`, `cancelled`, `lapsed`),
  when, who took it, when and why it ended. One open offer per shift (a partial unique index).
- **The race is decided by the offer's own trigger, not a guard kind.** An offer leaves `open`
  once: a `BEFORE UPDATE` trigger refuses any update of an offer that is not open
  (`core_staff_offer_closed`) and any change of what it offers. The take's statement updates the
  offer by its id alone (no `WHERE state = 'open'` that could silently match nothing), so of
  twenty takes, the first batch to commit moves it and every other batch fails whole at that
  statement (D1 runs one batch at a time). A `BEFORE INSERT` trigger refuses an id that exists and
  a second open offer of one shift, before an `INSERT OR REPLACE` could delete either (D1 runs with
  recursive triggers off). So **no `core_write_guard` kind was needed**: migration 0852, reserved
  for this remake, is released. The same trigger makes a rosterer's reassignment and a take
  exclusive: the reassignment cancels the open offer in its own batch, so whichever commits second
  fails.
- **The take is one batch**: the offer's move, the shift's person written through the record
  operations (as staff, so on a series' record it is a field exception, ADR 0620, and a later
  change of the series' coach leaves it), its time claim moved by the staffed triggers (refused if
  it overlaps another of the taker's shifts), the audit row, and the notices (the offerer, the
  rosterers: told, not asked).
- **Who is told who took it**: an operation may declare `explainFailure`, which the pipeline calls
  when its batch fails at commit, to read again and answer what happened. The take answers
  `offer_taken` with who took it and when (ADR 0437's answer).
- **Held to the rule, not warned** (decision 5 lets a take through *because* the taker is
  qualified): a take by someone with no qualification row for the shift's kind is refused
  (`not_qualified`), even where the business has set no qualifications up (which only silences the
  write's warning, ADR 0622). A shift with no kind can be taken by nobody. A taker away then is told
  and confirms (`confirmUnavailable`: it is their own time). A taker must have a profile the
  shift's person field can name (a class's coach profile).
- **Eligible** (who an offer to everyone tells): active staff accounts qualified for the kind, with
  a profile, not away over the shift and free, at most 100 read, never anyone's history. The
  offerer is never told who was left out or how many were told (a rosterer is told the count).
- **The cut-off**: an offer can be made and taken until 60 minutes before the shift starts
  (`OFFER_CUTOFF_MINUTES`; the Rostering pack's setting from step 4). After it a take is refused
  (`offer_cutoff`) and the minute cron's `staffing.due` lapses the offer: the offerer hears it is
  still theirs, the rosterers that it was not taken. An open offer whose shift is gone, in the
  Trash or no longer live is cancelled there too. A quiet minute is a few reads and no write.
- **The offerer stays responsible until it is taken.** Nothing about the shift changes when it is
  offered. There is no undo of a take: the taker offers it on, or a rosterer reassigns it.
- **A person's own act**: offering, taking and withdrawing are refused unless the calling tool is
  `humanOnly` (an assistant cannot do them for anyone). The operations are tool-only (ADR 0621).

## Consequences
- Rostering's tools (step 4) call `staffing.offer`, `staffing.take`, `staffing.withdraw` and
  `staffing.offers`; its `take` tool must be `humanOnly`.
- An offer's row keeps who offered and who took, which `staffing.forget` (a later step) deletes.
- `explainFailure` is available to any operation whose batch can lose a race it can explain.

## Amended 2026-11-23 (review of PR #282, before merge)
- **A take never removes someone who did not offer it.** Every write that changes who works a
  shift cancels its open offer by the shift, at commit (`WHERE object, record, state = 'open'`),
  not by an offer id read earlier, so an offer made while that write was in flight is cancelled
  too. A coach profile given another account cancels the open offers of every shift naming it. The
  take itself refuses (`offer_stale`) when the shift's person is no longer the offer's `from` (or an
  uncovered shift has someone on it), whatever path changed it.
- **The offer keeps its shift's start and kind**, kept current while it is open (the write that
  moves the shift moves them). The minute cron lapses offers in order of start through an index on
  open offers, so a near offer behind many far ones lapses on time; a taker's list reads only open
  offers before the cut-off, open to them, of a kind they are qualified for, soonest first, so the
  ones they can take are never hidden behind ones they cannot. Migration 0812 was edited in place
  (unmerged): a database that applied the earlier version must be rebuilt.
- **An offer nobody could take is refused** (`nobody_qualified`, a coordinator decision the owner
  may override): an offer to everyone, when nobody but the offerer is qualified for the shift's
  kind, or the shift has no kind. It is decided from qualifications alone, before anyone's leave or
  shifts are read, so the refusal says nothing about either. An offer to one named person is
  checked as before.

## Amended 2026-11-24 (stage 49 step 1, ADR 0761)
A shift whose title may name a client (`staffed.private`, an appointment) is never offered
(`conflict`, `rule: "offer_private"`): an offer shows it to others. A rosterer reassigns it. See
[ADR 0761](0761-a-shift-that-names-a-client-kept-off-the-roster-and-the-feed.md).
