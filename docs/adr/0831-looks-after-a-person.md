# ADR 0831: Looks after, and a shipped pack's declared team

Status: accepted, 2026-11-24 (stage 56, build step 1: the table and its operations; the declared
team is decided here and built with the first pack that needs it). Builds on
[ADR 0830](0830-note-levels-kept-out-of-every-bulk-path.md) and
[ADR 0540](0540-the-family-link.md) (`people:link`). Stage 56's spec, decisions 2 and 3.

## Context
A coach's session notes are read by that client's coaches, plus managers and admins (decision 2).
Who a client's coaches are must be chosen, not worked out from bookings: one covered class would
otherwise open a member's notes to a casual coach (decision 3).

## Decision
- **`core_person_carer`** (migration 1231): a Person, a staff account, who set it and when, and
  when and by whom it ended. One live row per pair; an ended row is kept and gives nothing. Erase
  removes a Person's rows by the foreign key, and removing the account removes its rows.
- **Operations**: `carer.set` and `carer.end` need `people:link` (admins by default, grantable)
  and are `actors: ["human"]`: a person on the Person's page decides, never the assistant, an MCP
  client, an automation or extension code. Each call's audit row records who set what; nothing
  goes on the timeline or to an automation. `carer.list` needs `records:read`. Only an active
  staff account can be set.
- **What a row allows** is decided by the seam alone (`visibility/notes.ts`): while live, the
  account reads the Person's `coaches` notes (a note at that level is about exactly one Person).
  Ending it takes effect on the next read; the account keeps the notes it wrote.
- **A shipped pack's team** (decided, not built yet): a shipped pack may declare an object's
  `team: { person: "<relation to Person>", staff: ["<user field>"] }`; the staff named on a live
  record about the Person count as looking after them while it is live (a job's crew until it
  closes). A runtime extension declaring it is refused. Bookings declares none. It is built with
  Jobs (stage 39), the first pack to need it.

## Consequences
- The "Looks after" panel on the Person and a coach's reach through the Bookings coach role are
  later steps of stage 56 (2 and 4).
- A merge moves looks-after rows to the survivor in stage 56 step 7; until then the duplicate's
  rows stay on the merged Person.

## Proof
`packages/core/test/note-levels.test.ts`: a coach set to look after a member reads their
`coaches` notes, stops on the next read after `carer.end` and keeps their own; `carer.set` is
refused to AI actors.
