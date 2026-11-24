# ADR 0830: Note levels, kept out of every bulk path, and the note scope in the seam

Status: accepted, 2026-11-24 (stage 56, build step 1). Generalises
[ADR 0112](0112-email-calendar-sync-service.md)'s `private_to`. Builds on
[ADR 0244](0244-visibility-enforced-at-one-seam.md) and [ADR 0410](0410-the-seams-first-door-as-built.md)
(one seam), [ADR 0019](0019-audit-redaction-for-erasure.md) (redaction at write) and
[ADR 0643](0643-health-answers-read-by-a-person-with-the-permission-every-read-audited.md) (reads
audited, for people only). Stage 56's spec, decisions 2, 4 and 10. Stage 43's authored rows
should cite this ADR, or amend it, rather than add a second design for "rows staff may not read
in bulk".

## Context
Coaches write notes about clients that the whole front desk should not read: session notes, and
injuries or circumstances that only a few named people may open. Every note so far was read by
every staff account, in every timeline, search, `query.sql`, dashboard, export, embedding,
summary and assistant read. One precedent existed: a synced email marked private leaves the base
view and the search index (migration 0111) and only its owner reads it. Hiding columns path by
path would be a dozen changes with one left out; keeping the rows out of the views closes those
paths at once.

## Decision
- **A note gains a level** (`core_activity.level`, migration 1230): `staff` (the default, and
  every existing note), `coaches` or `sensitive`. Only a `note` takes a level other than `staff`
  (triggers refuse any other type for every writer). The migration also adds the note's other
  columns the later steps fill (`kind_id`, `shared_at`, `shared_by`, `from_customer`, `evidence`,
  `sections`).
- **Levels 2 and 3 are out of every bulk path.** `core_base_activities` (and so `rec_activity`,
  which the reconciler builds over it), `rec_activity_link` and the search triggers keep only
  `staff` rows. `query.sql`, dashboards, exports, `activity.list`, search, the digest and every
  pack reading the views therefore never see them. `ai/embedding.ts` and `ai/summaries.ts` read
  `core_activity` directly and skip them too. Raising a note's level takes it out of search (the
  trigger fires on `level`) and its vector is deleted on the next drain; lowering puts it back.
- **The note scope is in the seam** (`visibility/notes.ts`). `visibleTable(ctx, "activity")` is
  where staff read activities with their Trash; it now keeps only the notes the caller may read:
  `staff` notes; `coaches` notes whose author is the caller (while their account is active),
  whose one Person the caller looks after (ADR 0831), or every one for admins and `notes:clients`;
  `sensitive` notes whose author is the caller, or every one for admins and `notes:sensitive`.
  A person who reads every level gets the plain table, the same SQL as before. Every activity
  operation, the Trash list and the approval simulation read through it, so a note the caller
  may not read is not found by id, not on a timeline and not counted.
- **The actor is known to the seam.** A staff handler's context carries its actor and its
  grants; the note scope reads them. Anyone who is not a person (`actor` other than `human`: the
  assistant, an MCP client, an automation, extension code) and work with no caller (`orgReader`)
  read `staff` notes only, whatever the account holds. Grants and looks-after rows are read on
  every call: removing one takes effect on the next read.
- **A sensitive note is listed locked** (`locked: true`, no subject or body) to those who may read
  it, and opened with `note.open` (`actors: ["human"]`, `auditReads`): one audit row per opening,
  the person's own included, naming the note and no text. `activity.getBody` returns no text for
  it.
- **A `coaches` note's text is audited per call.** A read that returns it (`activity.get`,
  `.listForRecord`, `.getBody`) writes one audit row naming the note ids (`ctx.auditRead`, a new
  context hook the pipeline turns into a row for a person's read too). Those operations are
  `auditForPeople`, so no AI actor lists the rows.
- **No text in the audit.** A change to a note at level 2 or 3, before or after, is recorded by
  field name (`subject` and `body` as `[redacted]`), carries `restricted` and is no automation
  event. `activity.log` and `activity.update` leave `subject` and `body` out of the audit row's
  input for every note (`auditRedact`, a new option: a staff note's text is in its change's diff,
  and a pending action keeps it for its approver). `audit.list` for an AI actor leaves out every
  row that changed such a note; `audit.listForRecord` gives a note's history only to someone who
  may read it. The merge and duplicate counts of linked activities, the audit list and a note's
  history leave out the notes the caller may not read (`hiddenNoteIds(ctx)`, read through a
  partial index on kept notes, `core_activity_kept_idx`). The Trash names a kept note by its type,
  never its text, to everyone.
- **A level change takes its copies with it.** Raising or lowering a note queues its embedding
  (its vector is dropped or made again, whatever path embeds, since a kept note's change is no
  record event). Raising it from `staff` deletes the cached summaries built from it and redacts
  its earlier audit rows (the change rows of the note, and the `activity.log` / `.update` /
  `.proposeNote` rows that made them) by ADR 0019's sanctioned redaction: a marker per row naming
  the operation that raised it, field names kept, values `[erased]`.
- **A change planned from a level fails when the level moved.** `activity.update` writes `level`
  only when it changes and carries a guard (`core_note_guard`, migration 1230): if another call
  changed the level between this call's read and its commit, the batch fails whole
  (`note_changed`), so a stale edit never puts back a level someone raised and a lowering is
  judged against the level it lowers.

## Consequences
- The Person's timeline shows each reader exactly the notes they may read; the admin screens
  that show the level, the lock and the composer's level picker are stage 56 step 2.
- A human's read in a dry run (`ctx.simulate`) writes no audit row; only the approval queue and
  test mode simulate, and neither reads restricted notes for a person.
- Stage 14a's owner and team scopes must extend `visibility/notes.ts`, not add a second scope.
- A pending action an AI proposed (`activity.proposeNote`) keeps its input and preview after the
  note it made is raised; only people who could approve it read those, as before.
- A carer reads nothing of a Person in the Trash.
- A clinical layer would add a level the seam routes (`clinical`), not a second table.

## Proof
`packages/core/test/note-levels.test.ts`: who reads each level and who does not, on timelines,
by id, in search, `query.sql` over `rec_activity` and `rec_activity_link`, exports, the feed, the
Trash, counts and history; each read and opening audited with ids and no text, and no audit row
holding the text; removing a grant, a looks-after or deactivating the author on the next read;
every AI actor with every grant reads nothing of them and lists none of their audit rows;
summaries and embeddings leave them out; a timeline read with the note scope runs a fixed number
of statements whatever the notes on it. From the review of PR #373: the Trash shows no kept
note's text; raising a note drops its cached summary, queues its vector and redacts its staff-level
audit history; a change planned from an old level fails whole. `visibility-staff-unchanged.test.ts` still passes: staff
reads return the same rows for the same `rows_read`.
