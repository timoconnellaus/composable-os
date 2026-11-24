# ADR 0832: The notes permissions, who changes what, and no AI with any grant

Status: accepted, 2026-11-24 (stage 56, build step 1). Amends
[ADR 0625](0625-restricted-pack-permissions.md) (restricted permissions, extended to core ones).
Builds on [ADR 0449](0449-permissions-granted-one-by-one.md) (grants),
[ADR 0830](0830-note-levels-kept-out-of-every-bulk-path.md) and
[ADR 0831](0831-looks-after-a-person.md). Stage 56's spec, decisions 2, 4 and 10.

## Context
There is no manager role: a business's managers must read every client's coaches notes by a
grant. Sensitive notes are read by people the business names one by one. Today any member may
change or delete any note.

## Decision
- **Three core permissions** (`principals.ts`): `notes:clients` reads every `coaches` note;
  `notes:sensitive` reads every `sensitive` note; `notes:manage` changes and deletes others' notes
  it can read and lowers levels. Admins hold all three by their role; anyone else only by a human
  admin's grant (`user.setPermissions`, `actors: ["human"]`, audited).
- **They are restricted**, as a pack's restricted permission is (ADR 0625):
  `RESTRICTED_CORE_PERMISSIONS`, listed `restricted` by `user.grantablePermissions`, so nobody
  grants one to their own account (`self_grant`); a fixed role's account cannot be granted any
  core permission (ADR 0600); no pack role holds them. Stage 14a's roles must not hold them by
  role.
- **Nothing for an AI actor.** The note scope reads the grants only for a person
  (`noteRights`): the assistant, an MCP client, an automation or extension code acting for an
  account that holds them reads no `coaches` or `sensitive` note and changes nothing they open.
- **Who writes**: any staff account with `records:write` writes a note at any level, a person
  only above `staff` (an AI drafts with `activity.proposeNote`, which waits for a person). A coach
  records an injury privately without holding `notes:sensitive`, and reads what they wrote. A
  note above `staff` is about exactly one Person (`note_one_person`).
- **Who changes and deletes a note**: its author, or `notes:manage` (with `notes:sensitive` for a
  sensitive note), and only one the caller can read. This narrows today's rule (any member) for
  notes; emails, calls and meetings are unchanged. Deleting a note is a person's act whoever
  approves (`note_delete_person`).
- **Levels**: anyone who may change a note raises its level; lowering it needs `notes:manage`
  (and `notes:sensitive` from `sensitive`), and any level change is a person's
  (`note_level_person`). A kind's lowest level is stage 56 step 2.

## Consequences
- Imported or synced notes with no author are changed only by `notes:manage`.
- `user.grantablePermissions` lists the three with their labels; the admin's grants screen shows
  them as restricted.

## Proof
`packages/core/test/note-levels.test.ts`: the three are listed restricted; granting one to
oneself is refused (`self_grant`) and an AI's grant is refused; another member cannot change or
delete an author's note and an admin can; raising by the author, lowering refused without
`notes:manage` and allowed to an admin, lowering a sensitive note refused with `notes:manage`
alone; a note about two People is refused above `staff`; an AI actor cannot write a kept note,
change a level, delete a note or set who looks after whom.
