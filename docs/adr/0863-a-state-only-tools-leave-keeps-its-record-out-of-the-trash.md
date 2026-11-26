# ADR 0863: A state only tools leave keeps its record out of the Trash

Status: accepted, 2026-11-26 (stage 59, build step 3, the review of PR #491). Block BU. Amends
[ADR 0425](0425-one-transition-engine-for-stages-and-states.md) (`states`) and
[ADR 0513](0513-a-granted-holder-keeps-what-it-was-granted.md) (moves only named tools make)
with this note; no migration.

## Context
ADR 0513 lets a pack say that a move is a person's act: `by: ["host"], tools: [...]`, so no record
write, board drag or import makes it. Equipment uses it for decision 4 of stage 59: any staff
member takes an item out of service, only a manager, in person, puts it back. The review of PR #491
found the way round it. `record.delete` held no states rule but for allowance holders, so a member
took a treadmill out, put it in the Trash, and made a new item with the same tag, in service. Under
the `autonomous` preset the assistant's `record.delete` of an out-of-service item went through with
no approval. A member could also Trash an open safety-risk fault and so skip the manager's triage.
Putting a record in the Trash takes it out of its lifecycle as surely as a move does, and that is
the host's to hold for every pack (ADR 0405), not Equipment's.

## Decision
- **A guarded state.** A state is guarded when it is not final, some move leaves it, and every move
  leaving it is made by the host alone (`by: ["host"]`, with or without `tools`). A state that
  staff or a customer may leave by a record write is not guarded, and nor is a final one.
- **Who may put a record in a guarded state in the Trash** by a record write (`record.delete`, and
  a customer's `my.delete`, which runs the same code):
  - one of the tools that make a move out of that state, from inside it (`personsTool`: a person's
    act, called by one or approved by one, ADRs 0513 and 0552); or
  - a **person** (the `human` actor) who holds the permission of one of those tools, as calling it
    would ask: a restricted one by being an admin or by its grant (ADR 0625), any other by being an
    admin or a member, or by its grant; an account on a pack role, by its role or a grant.
  - Nobody else: never the assistant, an MCP client, an automation or other code, whatever the
    preset, and an approval does not change that (an approved call runs as the actor that asked,
    ADR 0552). A customer never. A state only the host leaves (no tools) is never left by the
    Trash through a record write.
- **The refusal** is `forbidden`, `rule: "state_trash"`, and says which state and which tools:
  "Item is out of service, a state only putBack or retire moves it out of: only a person who may
  use one of them can put it in the Trash. Move it out of out of service first, or ask such a
  person." It runs after every other Trash rule, so each keeps its own words.
- **What is not a record write is not held here.** The host's own removals (a series' record that
  no longer fits its rule, `trashRecordAsHost`) stay as they are. Erase (ADR 0320) clears and
  rewrites fields and merge re-points relations; neither puts an extension record in the Trash, so
  erasing a person works as before. There is no bulk delete of extension records: the admin's
  "delete selected" calls `record.delete` for each, and each is held.
- **A restore that would clash on a declared unique field says so** (ADR 0864): "This item cannot
  come back from the Trash: another item now has the same Tag. Change or remove that one first,
  then restore this one." (`rule: "unique"`, `reason: "taken_while_in_trash"`), before the batch,
  instead of the race's "a record like this one was made at the same moment".

The rule is a little wider than "only the tools": the person who could make the move may also
Trash the record. Without it a submission marked spam (Forms: only `notSpam` leaves `spam`) could
never be deleted, and an item added by mistake (in service: only `takeOut`, `reportFault` and
`retire` leave it) could not be removed without first making a move. Holding the Trash to whoever
could make the move keeps what the moves protect (the out-of-service item is a manager's, the open
fault a manager's) and nothing more.

## What it changes for the shipped packs
Checked with each pack's manifest (every state that is guarded) and its tests, run with the rule:

| Pack | Guarded states | Change |
| --- | --- | --- |
| Equipment | item `in_service` (takeOut, reportFault, retire), `out_of_service` (putBack, retire); fault `reported`, `acknowledged` (triage) | The point of it: an out-of-service item and an open fault are a manager's to Trash, in person; an item in service any member's, as before; never an AI's |
| Forms | submission `spam` (notSpam) | A spam submission is Trashed by a person who may use `notSpam` (every member: its permission is not restricted), no longer by the assistant or an automation |
| Bookings | booking `pending`, `late_cancelled`; appointment `pending` (cancelAppointmentByUs), `late_cancelled` (excuseAppointment) | None in practice: a pending booking holds a place and a late-cancelled one has spent a use, which the Trash already refused (ADRs 0501, 0493); those refusals keep their words. The appointment's are now a person's who may use the tool, no longer an AI's |
| Memberships | membership `trialing`, `active`, `past_due`, `unpaid`, `paused` (host only); pass `active` (voidPass) | None: a live holder was already refused the Trash (ADR 0513), with its own words |
| Ticketing, Shop, Knowledge, Programs, Content, Courses, Rostering, Deals, Leads, Lifecycle, Daily checklists | none | None |

Offers' discounts (open PR #479) are not on `main`; a discount's live states, if every move out is
the host's, will be held the same way once it merges, and its tests will say whether its words
need to change.

## Consequences
- A pack that guards a state with tools gets this without declaring anything; a pack that wants a
  record in such a state to be removable by others gives it a way out of the state first.
- The rule is enforced in `trashRecord` (`packages/core/src/records/trash-states.ts`), so it holds
  for the record page, a board, the assistant, MCP and any extension's code.

## Proof
`apps/runner/test/equipment.test.ts`, "the Trash (ADR 0863)": a member's Trash of an
out-of-service item is refused, so no second item with its tag can be made; the assistant and an
MCP client are refused under balanced (asked and, once approved, not applied) and under
autonomous; a manager in person Trashes it and a member Trashes an item in service; an open fault
is refused to a member and Trashed once closed; a restore whose tag was taken says so. With the
rule taken out of `trashRecord`, those tests fail (listed in the pull request).
