# ADR 0926: Erase, merge and removal of the outside copy

Status: accepted, 2026-11-26 (stage 65 build, step 10). Block CA. Builds on ADRs
[0922](0922-the-outside-copy.md) (the outside copy), [0320](0320-erase-reaches-every-store.md)
(erase reaches every store), [0019](0019-audit-redaction-for-erasure.md) (redaction),
[0675](0675-consent-to-be-contacted.md) (the keyed suppression list), [0692](0692-one-person-per-folded-address.md),
[0500](0500-recurring-a-weekly-rule-in-local-time.md) (the Worker budgets), [0863](0863-a-state-only-tools-leave-keeps-its-record-out-of-the-trash.md)
and [0865](0865-a-field-locked-in-some-states-and-a-write-while-in-one.md). No migration: migration
1410 made every table this uses. Spec: [stage 65](../stages/65-booking-system-connection.md),
acceptance criterion 12 and "Privacy, audit and erase".

## Context

Step 3 built the host's copy of a business's booking system and left erase, merge and removal to
step 10, which gates step 4 (loading a list): from step 4 on a list can be loaded, and without
this `person.erase` would leave an erased Person's outside rows behind, and the next load would
bring them back. Erase is the platform's most sensitive path (ADR 0320): after it nothing of the
Person may be readable anywhere, and nothing may bring them back.

## Decision

**Which outside rows are a Person's.** Those linked to them (by address or by staff), and those
listed with one of their addresses exactly as normalised (current and former, as the erase finds
them): the erased-address list would drop those at the next load anyway (rule 2 of the matching),
so they go now rather than wait. Coaches whose address is theirs are theirs too. A row only sharing
a folded form with one of their addresses (`a+x@` beside `a@`) is not deleted: it can be another
Person's, and it is matched again.

**Erase** (`queueErase`, for a person; `outside/erase.ts`). Read before the erase builds its terms
(three indexed reads): the refs, the addresses and the names the copy lists them by join the
erase's terms and names, so the audit, pending actions, tasks, activities and assistant threads
lose them as they lose the Person's own. In the erase's own batch, set based (each list one JSON
parameter, about ten statements whatever the copy holds): their memberships and passes, their
bookings (by ref, and by `email:<address>` for a list with no ids), their To match rows, their id
in every other row's candidates, staff's "nobody here" decisions about their refs, the coach on
their classes, their coaches and their outside people are deleted. The result gains
`bookingSystem: { people, coaches, copyRemains: true, note }`, "a copy remains in the booking
system": the host cannot remove it there, and staff deal with it there.

**Suppression, by keyed hash.** `core_outside_suppressed` gets the hash of each ref deleted
(`ref`: `outside:person:ref:…` or `outside:staff:ref:…`) and of each address the copy held for
them (`address`: the normalised address), keyed with the deployment's salt (`saltedHash`, the
consent register's suppression list's, ADR 0675), never the value. A list with no ids uses the
address as the ref, so a plain digest of a ref would be an address digest anyone could recompute;
the salt keeps one deployment's hashes from matching another's. Every load reads it with the
erased-address list: a members list keeps no outside person it names (by ref, so a changed address
under the same ref is still dropped; by address, so the same address under a new ref is dropped
too), a timetable keeps no booking of theirs and no coach of theirs (a coach dropped leaves their
classes with no coach), and `outside.link` refuses a row it names (`outside_erased`) should one be
there by any other way. Step 3's unlink decisions (`core_outside_unlinked`) move to the same keyed
hash (no list has been loaded outside tests yet, so nothing stored is rehashed).

An address another outside person in the copy still holds (a family on one mailbox) is not
suppressed: that would drop the others at the next load, and the address is theirs as much as the
erased Person's. The erased Person's own addresses are on the erased-address list regardless, as
for mail.

**The erase log** carries the suppression hashes (`outside`, already hashes) beside the erased ids
and addresses, and `erasure.reapply` puts them back after a restore.

**Merge** (`person.merge`): the duplicate's links move to the survivor (one `UPDATE`; each outside
person is one row by ref, so none is lost or doubled, and two outside people linked to one Person
stay two). In To match the survivor takes the duplicate's place among the candidates; an outside
person who waited (`several_people`) only because the two were two Persons with the address is
linked now, by address, with one timeline activity. Nobody else's outside row moves. An erase of
the merged-away Person afterwards finds nothing of the copy and does not fail; an erase of the
survivor removes what both had.

**Purge** (`trash.purge`): a purged Person's links go and they leave the candidates; the outside
people stay, unlinked, as the booking system lists them (a purge is retention, not an erasure
request), and are matched again at the next load.

**Removal** (`outside.lists.remove { kind: members | timetable | all }`, staff only, a person with
`bookingSystem:manage`, `actors: ["human"]`, never MCP, Code Mode, an extension or an automation,
whatever the preset). `all` is what disconnecting the booking system means for a list source.
The current list is marked `removed` at once, and the rows go in the same batch: one read of
counts (scalar subqueries, no compound SELECT), one read of the lists, one update, and at most 100
deletes of at most 2,000 rows each (each binding at most two parameters), so a call holds about
105 statements whatever the copy is, far under D1's 1,000. A copy bigger than one call's 200,000
rows is removed by calling again (`done: false`, `remaining`): what is left belongs to no current
list, and every read of the copy holds to the current lists (`onCurrentList`: `outside.status`,
`outside.matches`, `outside.settings.get`, the link checks, a Person write's matching, and a load's
held links and booked people), so nothing reads or links it meanwhile; the next load of its kind
replaces it anyway. A file list holds at most 20,000 rows (`CSV_LIMITS`), so in practice one call
does it. **Kept**: the settings (the business's, no person), the lists' log rows (counts only, 30
days, as replaced lists), the suppressions (without them an erased Person comes back with the next
list), the unlink decisions (a keyed hash of a ref, no person), the timeline's "Linked to the
booking system's list" activities (a Person's history, naming no address) and the audit (counts
only). Turning the copy off (`outside.settings.update { enabled: false }`) still keeps it, as
step 3 decided.

**Nothing holds them.** The copy is core rows with no states, no Trash, no trigger and no write
guard, so ADRs 0863 and 0865 (which hold record writes) do not reach it: erase and removal are the
host's own removals and cannot be blocked by a guarded state or a hold.

## Consequences

- Step 4 may merge: no list can be loaded on a host whose erase leaves an outside copy behind.
- A Person who comes back by consent (`erasure.allowAddress`) is back on mail, but their old outside
  refs and the addresses only the copy held stay suppressed: the booking system's record of them
  under a new ref, with a new address, is matched as anyone's. Lifting a copy suppression is not
  built; it would be an admin's act beside `erasure.allowAddress`.
- Bookings of an outside person never kept in the members copy (booked but not a member) are named
  by an opaque ref the host cannot tie to the erased Person; they hold no name or address.
- A staff account has no erase: its outside coach is linked to it until it is deactivated (and
  then matched again). Erasing a Person removes a coach row that has their address.

## Proof

`packages/core/test/outside-erase.test.ts`: a Person with a full copy (linked by address and by
staff, a coach with their address, an outside person on their address waiting, a candidate in
another's match, memberships, passes, bookings, a task naming the copy's address) is erased with
blob storage, then every table and the erase log are scanned for their id, addresses, refs and
names (none) while a bystander's copy is unchanged; reloads, a sign-up with the address and a link
by hand bring none back, by ref or address; a family member on a shared address stays; merge,
an erase of the merged-away Person, then of the survivor; purge; `erasure.reapply`; removal's who
(balanced and autonomous presets, every non-human actor, Code Mode) and what is kept.
`packages/core/test/outside-bounds.test.ts`: an erase over a copy of 20 and of 6,000 people costs
no more statements at the larger, none binding over 100 or compounding over 5 terms; removal at
both sizes stays within its bound; a copy bigger than one call's passes resumes, each call within
the bound, with nothing reading or linking the rest between calls. `erase-stores.test.ts` seeds the
copy into the every-store erase.
