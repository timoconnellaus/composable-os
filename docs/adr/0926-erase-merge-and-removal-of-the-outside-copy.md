# ADR 0926: Erase, merge and removal of the outside copy

Status: accepted, 2026-11-26 (stage 65 build, step 10; revised the same day after the review of
PR #508). Block CA. Builds on ADRs [0922](0922-the-outside-copy.md) (the outside copy),
[0320](0320-erase-reaches-every-store.md) (erase reaches every store),
[0019](0019-audit-redaction-for-erasure.md) (redaction), [0675](0675-consent-to-be-contacted.md)
(the keyed suppression list), [0692](0692-one-person-per-folded-address.md),
[0500](0500-recurring-a-weekly-rule-in-local-time.md) (the Worker budgets),
[0863](0863-a-state-only-tools-leave-keeps-its-record-out-of-the-trash.md) and
[0865](0865-a-field-locked-in-some-states-and-a-write-while-in-one.md). Migration 1412 (which
erase a suppression came from, and the salt's fingerprint). Spec:
[stage 65](../stages/65-booking-system-connection.md), acceptance criterion 12 and "Privacy, audit
and erase".

## Context

Step 3 built the host's copy of a business's booking system and left erase, merge and removal to
step 10, which gates step 4 (loading a list): from step 4 on a list can be loaded, and without
this `person.erase` would leave an erased Person's outside rows behind, and the next load would
bring them back. Erase is the platform's most sensitive path (ADR 0320): after it nothing of the
Person may be readable anywhere, and nothing may bring them back. It must also take nothing that
is someone else's: a booking system lists families on one mailbox, and its ids are often plain
numbers.

## Decision

**Which outside rows are the erased Person's** (`outside/erase.ts`, `outsideOf`):

- an outside person **linked to them**, by address or by staff;
- an outside person **linked to nobody**, listed with one of their addresses exactly (as
  normalised), **when it can only be theirs**: no other outside person is on that address (by its
  folded form), and no other live Person holds it exactly;
- a coach listed with one of their addresses and **linked to no staff account**. The spec ties
  coaches to staff accounts ("erasing a staff account unlinks its outside staff"); a coach linked
  to one is that account's, kept when the Person with its address is erased (an employee who
  erases their member record stays a coach). The result counts them (`coachesOfStaff`).

A row linked to another live Person, or to a staff account, is never deleted, suppressed or
added to the erase's terms, whatever address it lists. A row on their address that another
outside person shares, linked to nobody, stays: the spec's rule 2 (the erased-address list) drops
it at the next load while it lists the erased address, and it comes back, matched again, once the
booking system lists its own.

**Erase** (in `queueErase`, for a person). Read before the erase builds its terms (a few indexed
reads): the addresses and names of their rows join the erase's terms and names, so the audit,
pending actions, tasks, activities and assistant threads lose them as they lose the Person's own.
**Their outside refs do not**: a booking system's ids are often numbers ("123456"), which would
blank unrelated text ("Order 123456 for supplier"). Refs are scrubbed only where the copy keeps
them (its own rows, deleted here); the outside operations' audit never keeps one (`redact: ["ref"]`).
A ref staff typed into free text elsewhere is not found. In the erase's own batch, set based
(each list one JSON parameter, about ten statements whatever the copy holds): their memberships
and passes, their bookings (by their refs, and by `email:<address>` of their addresses no row that
stays lists), their To match rows, their id in every other row's candidates, staff's "nobody here"
decisions about their refs, the coach on their classes, their coaches and their outside people.
Their full names (a person's given and family name, a coach's display name, 6 characters or more,
at most 20) are replaced with `[erased]` in the booking system's own text the copy holds (class
titles, class type names and descriptions), one statement a name; the result counts the rows
(`textScrubbed`), and a later list brings back whatever the booking system still says. The result
gains `bookingSystem: { people, coaches, coachesOfStaff, textScrubbed, copyRemains: true, note }`,
"a copy remains in the booking system": the host cannot remove it there.

**Suppression, by keyed hash.** `core_outside_suppressed` gets the hash of each of their rows'
refs (`ref`: `outside:person:ref:…` or `outside:staff:ref:…`) and of each address their rows list
that no row that stays lists (`address`: the normalised address), keyed with the deployment's salt
(`saltedHash`, the consent register's suppression list's, ADR 0675), never the value; with the
erase it came from (`erase_id`) and the salt's fingerprint (migration 1412). A list with no ids
uses the address as the ref, so a plain digest would be one anyone could recompute from an
address. Every load reads it with the erased-address list: a members list keeps no outside person
it names (by ref, so a changed address under the same ref is still dropped; by address, so the
same address under a new ref is dropped too), a timetable keeps no booking of theirs and no coach
of theirs (a coach dropped leaves their classes with no coach), and `outside.link` refuses a row
it names (`outside_erased`). Step 3's unlink decisions (`core_outside_unlinked`) move to the same
keyed hash (no list has been loaded outside tests, so nothing stored is rehashed). A plus-tag or
dotted spelling of an erased address (`a+gym@`, `a.b@` for `ab@`) is a different address to the
host: it is neither on the erased-address list nor suppressed, and is matched as anyone's.

**A ref the booking system reuses.** A load counts what it drops by a suppressed ref
(`previouslyErased`), and a person with `bookingSystem:manage` lifts one by hand
(`outside.suppression.lift`, with why; never an AI, MCP, an extension or an automation), recorded
in the erase log as an `allow` so a re-apply keeps it.

**Consent to come back.** `erasure.allowAddress` lifts the address's copy suppression too, with
the refs the same erase suppressed (they were that Person's; their own consent lifts them); the
erase's other addresses stay until each is allowed. Its result says what it lifted, and its erase
log entry carries the hashes so a re-apply keeps the decision.

**A lost salt is refused, loudly.** The salt is in `core_settings`, and a restore without it would
make a new one (`contact/suppression.ts`) under which every suppression matches nothing. Each
suppression row and each erase-log entry carries the salt's fingerprint (a keyed hash of a
constant, never the salt); `droppedOf` (every load, and `outside.link`) refuses when a row's
fingerprint is not the one in use, and `erasure.reapply` refuses before doing anything when the
log's is not, each saying to restore the `text_number_salt` row.

**The erase log** carries the suppression hashes, the erase id and the fingerprint beside the
erased ids and addresses, and `erasure.reapply` puts them back after a restore.

**Merge** (`person.merge`): the duplicate's links move to the survivor (one `UPDATE`; each outside
person is one row by ref, so none is lost or doubled, and two outside people linked to one Person
stay two). In To match the survivor takes the duplicate's place among the candidates; an outside
person who waited (`several_people`) only because the two were two Persons with the address is
linked now, by address, with one timeline activity (only a current list's rows). Nobody else's
outside row moves. An erase of the merged-away Person afterwards finds nothing of the copy and
does not fail; an erase of the survivor removes what both had.

**Purge** (`trash.purge`): a purged Person's links go and they leave the candidates; the outside
people stay, unlinked, as the booking system lists them (a purge is retention, not an erasure
request), and are matched again at the next load.

**Removal** (`outside.lists.remove { kind: members | timetable | all, finish? }`, staff only, a
person with `bookingSystem:manage`, `actors: ["human"]`, never MCP, Code Mode, an extension or an
automation, whatever the preset). `all` is what disconnecting the booking system means for a list
source. The current list is marked `removed` at once, and the rows go in the same batch: one read
of the lists, one read of counts (scalar subqueries, no compound SELECT), one update, and at most
100 deletes of at most 2,000 rows each (each binding two parameters), about 105 statements a call
whatever the copy, far under D1's 1,000. **Every pass takes only rows of no current list**, so a
list loaded meanwhile is never touched. A copy bigger than one call's 200,000 rows returns
`done: false`: the daily maintenance finishes it (`finishOutsideRemoval`, the same bounds), or a
person calls again with `finish: true`, which removes no current list. Meanwhile every read of the
copy holds to the current lists (`onCurrentList`: `outside.status`, `outside.matches`,
`outside.settings.get`, the link checks, a Person write's matching, merge's To match, and a load's
held links and booked people). A file list holds at most 20,000 rows (`CSV_LIMITS`), so in
practice one call does it. **Kept**: the settings (the business's, no person), the lists' log rows
(counts only, 30 days, as replaced lists), the suppressions (without them an erased Person comes
back with the next list), the unlink decisions (a keyed hash of a ref, no person), the timeline's
"Linked to the booking system's list" activities (a Person's history, naming no address) and the
audit (counts only). Turning the copy off (`outside.settings.update { enabled: false }`) still
keeps it, as step 3 decided.

**Nothing holds them.** The copy is core rows with no states, no Trash, no trigger and no write
guard, so ADRs 0863 and 0865 (which hold record writes) do not reach it: erase and removal are the
host's own removals and cannot be blocked by a guarded state or a hold.

## Consequences

- Step 4 may merge: no list can be loaded on a host whose erase leaves an outside copy behind.
- A family member on the erased Person's own address keeps their row, memberships and ref, but the
  next load drops it while it lists the erased address (the erased-address list, as for mail);
  they are back once the booking system lists their own address, or once an admin allows the
  address on consent.
- Bookings of an outside person never kept in the members copy (booked but not a member) are named
  by an opaque ref the host cannot tie to the erased Person; they hold no name or address.
- A ref typed into free text by staff (a task, a note) is not scrubbed; the address beside it is.
- A staff account has no erase: its outside coach is linked to it until it is deactivated (and
  then matched again).

## Proof

`packages/core/test/outside-erase.test.ts`: a Person with a full copy (linked by address and by
staff, a coach with their address, an outside person on their address waiting, a candidate in
another's match, memberships, passes, bookings, a task naming the copy's address) is erased with
blob storage, then every table and the erase log are scanned for their id, addresses, refs and
names (none) while a bystander's copy is unchanged; reloads, a sign-up with the address and a link
by hand bring none back, by ref or address; a ref lifted by a person; a family on the erased
Person's own address, erasing the parent and the child, and a row on it linked to nobody; a row on
their address staff-linked to another Person; consent to come back; a numeric ref beside unrelated
text; a coach linked to a staff account; a coach's name in class titles and a class type; a lost
salt refused by a load, a link and a re-apply; merge, an erase of the merged-away Person, then of
the survivor; purge; `erasure.reapply`; removal's who (balanced and autonomous presets, every
non-human actor, Code Mode) and what is kept. `packages/core/test/outside-bounds.test.ts`: an
erase over a copy of 20 and of 6,000 people costs no more statements at the larger, none binding
over 100 or compounding over 5 terms; removal at both sizes stays within its bound; a copy bigger
than one call's passes resumes, each call within the bound, with nothing reading or linking the
rest between calls; finishing by a call or the daily maintenance leaves a list loaded since
untouched. `erase-stores.test.ts` seeds the copy into the every-store erase.
