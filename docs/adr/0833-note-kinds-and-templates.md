# ADR 0833: Note kinds and templates

Status: accepted, 2026-11-24 (stage 56, build step 2). Builds on
[ADR 0830](0830-note-levels-kept-out-of-every-bulk-path.md) (levels) and
[ADR 0832](0832-the-notes-permissions.md) (`notes:manage`, no AI with any grant). Stage 56's spec,
decisions 2, 4, 8 and 9.

## Context
A coach writes the same session note after every class (what was worked on, how it went, what
next), and the business wants it kept to that client's coaches by default. An injury note must
never sit below the sensitive level, whoever writes it. Step 1 gave a note a level; nothing yet
said what kind of note it is, where it starts, or how low it may go.

## Decision
- **`core_note_kind`** (migration 1232): a name (unique, ignoring case), the level a note of it
  starts at (`default_level`), the lowest level one may have (`lowest_level`, never above the
  default), a template (at most 12 sections: a key, a label, an optional hint, required or not),
  a position, active or retired. Not personal: every staff account reads it (`note.kinds.list`).
  It also holds the columns later steps set and read: files allowed (step 3), evidence and
  retention in whole years (step 7). Until those steps, nothing sets them and nothing reads them.
- **Four kinds ship**, found by their `key`: Note (`staff`), Session note (`coaches`, lowest
  `staff`; Worked on (required) / How it went / Next time), Sensitive (`sensitive`, lowest
  `sensitive`) and From the client (`coaches`, files allowed, for step 6). A business's own have no
  key.
- **Every note has a kind.** `activity.log` takes `kindId` (default Note); every note held before
  this step is a Note (the migration sets it), and a note any path writes without one reads as a
  Note. **Note stays `staff` and is never retired** (a check constraint and the operations): it is
  the kind of the assistant's drafts (`activity.proposeNote`), imports and API writes that name
  none, so a note written without a kind is read exactly as notes always were. A business that
  wants notes kept tighter adds a kind of its own.
- **A note starts at its kind's level and is never below its lowest.** The level given, or the
  kind's own; `activity.log` and `.update` refuse one below the lowest (`note_below_kind`), even
  to an admin who may lower levels, and migration 1232's triggers refuse it to every writer,
  against a kind changed meanwhile. A note moves only to a kind in use (`note_kind_retired`).
  Evidence is copied from the kind at write and never taken away (a move to an evidence kind
  sets it; a move away keeps it).
- **A template fills the note's body.** `sections` (each a template key and its text) replace
  the body: the host checks each key, refuses an empty required section, and writes the body as
  Markdown (`**Label**` then the text, for each filled section) so every path that reads a note's
  body (timeline, search, summaries for a `staff` note) reads it unchanged. The filled sections are
  kept with their labels as written (`core_activity.sections`), so a note reads alone after its
  template changes. A kind with a required section takes its sections, not a body alone; a body
  written over a template note later replaces its sections.
- **Keeping the kinds is `notes:manage`'s** (`note.kinds.save`, `note.kinds.retire`), admins and
  grants. **A kind's levels are a person's**: an assistant or MCP client acting for someone who
  holds it may draft a kind's name and template wording (`note_kind_level_person` refuses any
  level it sets or changes), and its write always waits for a person who holds `notes:manage`
  too (`alwaysReview`, the approver checked at approval). Retiring is `actors: ["human"]`.
- **A kind's level changed applies to notes written from then on.** Notes already written keep
  their level: raising many notes at once is a bulk privacy change (each needs its vector,
  summaries and audit text handled, ADR 0830) that a person makes note by note, or a later step.
- **The composer**: a base-layer block in both skins (`web-note-composer`,
  `native-note-composer`) over a headless entry in the client runtime
  (`@composable-os/client`'s `notes.ts`: `createNotesHooks`, the draft functions, the level
  words). It offers the kinds and levels the host lists and shows the host's refusal; it checks
  nothing the host does not check again. The admin's own timeline composer uses the same draft
  functions, and Settings → Notes keeps the list.

## Consequences
- An AI writing a Session note must pass a level of `staff` (a person writes it at `coaches`);
  logging one with the kind's default is refused, as any note above `staff` is.
- A business's raised lowest level does not reach old notes. The Settings screen says so.
- Files, evidence, retention and the client's upload level join Settings → Notes with their steps.

## Proof
`packages/core/test/note-kinds.test.ts`: the shipped kinds and their templates; Note stays
`staff` and is not retired (operation and constraint); a Session note's body made from its
sections and its text in no audit row; an empty required section, an unknown section and a body
beside sections refused; a note below its kind's lowest refused to an admin and to a raw write; a
note written without a kind, or by a path naming none, reads as a Note; moving a note to another
kind; a retired kind refused and its notes keeping it; `notes:manage` needed, keys kept across a
label change; an AI's draft waiting for a person with `notes:manage`, and an AI refused any level
and the retiring. `packages/client/test/notes.test.ts`: the composer's draft logic.
