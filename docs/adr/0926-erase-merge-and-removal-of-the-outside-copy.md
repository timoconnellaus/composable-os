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

**The rule, when Person P is erased** (`outside/erase.ts`; revised after the second review of
PR #508, and again after its third: one rule for the erase and the load, `keptByLink`). Two
separate questions.

*A. Which rows are deleted from the copy* (`outsideOf`):

1. every outside person linked to P, by address or by staff;
2. every outside person linked to nobody, listed with one of P's own addresses (folded, as
   matching folds them), where no other identified Person or customer account holds that address
   (`personsByFolded`, `addressesHeldByOthers`), however many unlinked rows share it: they can
   only be P's household's unmatched copies, the next load would drop them anyway (the
   erased-address list), and leaving P's own row readable is the worse failure. A family in To
   match as `shared_address` on P's address goes now;
3. every coach on P's address linked to no staff account (the spec ties coaches to staff accounts:
   a coach linked to one is that account's, kept when the Person with its address is erased).

Never deleted: a row linked to another live Person or to a staff account, whatever address it
lists. **The same rule holds at every later load** (`keptByLink` in `outside/match.ts`, the one
function both call): a row whose held link is to a live Person, or a coach linked to an active
staff account, is not dropped for an address on the erased-address list (a child staff-linked to
their own Person on a parent's mailbox, a staff account's coach who shares an address with an
erased member), load after load. Only a suppressed ref or a suppressed outside address drops it.
A row on P's address waiting as `several_people` (another Person holds it too) stays at the erase
(it may be theirs), but, linked to nobody, the next load drops it while it lists P's address,
which is on the erased-address list. With each deleted row go its memberships, passes, bookings (by ref, and by
`email:<address>` for an address that is suppressed), To match rows, and staff's unlink decision.
P's id leaves every other row's candidates.

*B. What is suppressed and what becomes a search term:*

- The addresses (P's own, and those every deleted row lists) are suppressed and become terms,
  except a shared address: one another identified Person or customer account holds, for rows
  under A.1 as well as A.2 (a husband's staff-linked row listing his wife's address leaves her
  address alone), and one a row kept because it is linked to someone else still lists (see
  "Where this goes beyond the rule given" below).
- Refs are suppressed for rows linked to P (A.1), and for coaches deleted under A.3 whose address
  no one else holds (it can only be P's: an erased coach does not come back when the booking
  system changes the coach's address). For rows deleted under A.2 no ref is suppressed: one may be
  a family member's. Their address keeps them out of later loads, but **if the booking system
  later lists such a row under another address, it comes back** (the result's `deletedUnlinked`
  says so).
- Every address the erase considered (P's own and those the deleted rows list) is recorded for
  the erase in `core_outside_suppressed_erase`, suppressed or not, so consent finds that erase's
  refs even when the address was shared (below).
- P's own live addresses go on the core erased-address list and into the erase's terms whatever
  this rule says (ADR 0320); "shared" here is about the copy's suppression only.
- Names become terms only from rows linked to P. The copy's own free text (class titles, class
  type names and descriptions) is scrubbed of the full names of the rows linked to P, the coaches
  deleted as P's, and P's own Person record (`outside/names.ts`): two words or more, never one
  (it would hit ordinary words); whole words in any case and any script's capitals (É, Ö, Ł, matched
  in code, never by SQLite's ASCII-only `lower()`), NFC or NFD, a straight or curly apostrophe
  alike; a hyphen is inside a word, so "<name>-Smith" (a living double-barrelled name) is left
  whole. Names in a script written without spaces between words are not matched. **A later
  timetable load scrubs the same way the name of an erased coach it drops** (`planTimetable`,
  counted as `textScrubbed` in the load's result). A member named in a title a later list brings
  is not matched: nothing of their name is kept after the erase (it would need keyed hashes of
  erased names; not built).
- Refs never become free-text terms: a booking system's ids are often numbers ("123456"), which
  would blank unrelated text ("Order 123456 for supplier"). They are scrubbed only where the copy
  keeps them (its own rows, deleted here); the outside operations' audit never keeps one.

*C. What staff are told.* Whenever the copy exists (a list is current, or anything was found),
the result has `bookingSystem: { deletedLinked, deletedUnlinked, coaches, keptLinkedToOthers,
keptWaiting, keptNamedElsewhere, sharedAddresses, textScrubbed, copyRemains: true, note }`: counts
only, never an address; "a copy remains in the booking system": the host cannot remove it there.
`keptNamedElsewhere` counts outside people linked to nobody that list P's own full name on an
address someone else holds (a child erased before the parent whose mailbox they are on): left, as
they cannot be told from a namesake, for staff to decide.

**Where this goes beyond the rule given.** The coordinator's rule B names one exception to
suppressing an address: another identified Person or customer account holding it. Applied alone it
would suppress an address that only the copy holds, listed both by a row linked to P and by a row
staff-linked to a family member's own Person, and so drop that family member at every later load
(the first review's blocker, which this ADR's first revision fixed and a test holds). So a second
exception is kept: an address a row kept because it is linked to someone else still lists is
shared too. Removing it fails "keeps the others on an erased Person's outside address" and
"erasing the parent leaves the child's row … alone".

**Erase** (in `queueErase`, for a person). Read before the erase builds its terms (a few indexed
reads), refusing first when the suppressions' salt is not the one in use (below). In the erase's
own batch, set based (each list one JSON parameter, about ten statements whatever the copy holds;
the free-text scrub 100 rows a statement).

**Suppression, by keyed hash.** `core_outside_suppressed` gets the hash of each ref and address
rule B suppresses (`ref`: `outside:person:ref:…`; `address`: the normalised address), keyed
with the deployment's salt (`saltedHash`, the consent register's suppression list's, ADR 0675),
never the value, with the salt's fingerprint; and `core_outside_suppressed_erase` a row per erase
and hash, however many erases suppressed it (migration 1412). A list with no ids
uses the address as the ref, so a plain digest would be one anyone could recompute from an
address. Every load reads it with the erased-address list: a members list keeps no outside person
it names (by ref, so a changed address under the same ref is still dropped; by address, so the
same address under a new ref is dropped too), a timetable keeps no booking of theirs and no coach
of theirs (a coach dropped leaves their classes with no coach), and `outside.link` refuses a row
it names (`outside_erased`). Step 3's unlink decisions (`core_outside_unlinked`) move to the same
keyed hash (no list has been loaded outside tests, so nothing stored is rehashed). The
suppression and the erased-address list hold exact (normalised) addresses: a plus-tag spelling of
an erased address (`a+gym@` for `a@`) is caught by rule A at the erase (which folds, as matching
does), but a later list listing it under a new ref is not dropped; a dotted spelling (`a.b@` for
`ab@`) is a different address everywhere.

**A ref the booking system reuses.** A load counts what it drops by a suppressed ref
(`previouslyErased`), and a person holding both `bookingSystem:manage` and `records:erase` (the
erase's own permission: lifting undoes an erase's protection for that ref, and brings the erased
person back if the booking system still lists them under it) lifts one by hand
(`outside.suppression.lift`, with why; never an AI, MCP, an extension or an automation), recorded
in the erase log as an `allow` so a re-apply keeps it.

**Consent to come back.** `erasure.allowAddress` reads the erases that recorded the address,
suppressed or not. When exactly one did, the consent is that erase's Person's: its refs (but one
another erase also suppressed) and its suppression of the address are lifted, even when the
address itself was shared and not suppressed (a parent whose child kept the mailbox). When
several did, whose consent it is cannot be told: nothing of any erase is lifted, the address's
copy suppression included (it may be another erase's), and the refs are counted (`refsLeft`) for
a person with `records:erase` to lift the right one. So one erased Person's consent never lifts
another erased Person's ref. The erase's other
addresses stay until each is allowed. Its result says what it lifted, and its erase
log entry carries the hashes so a re-apply keeps the decision.

**A lost salt is refused, loudly.** The salt is in `core_settings`, and a restore without it would
make a new one (`contact/suppression.ts`) under which every suppression matches nothing. Each
suppression row and each erase-log entry carries the salt's fingerprint (a keyed hash of a
constant, never the salt); `droppedOf` (every load, and `outside.link`) and the erase itself
(before writing anything: rows keyed with the new salt would match nothing once the old one is
restored) refuse when a row's fingerprint is not the one in use, and `erasure.reapply` refuses before doing anything when the
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
- A family member on the erased Person's own address keeps their row, memberships and ref when
  staff linked it to their own Person, at the erase and at every later load (`keptByLink`). Linked
  to nobody, it goes with the erase (rule A.2), ref unsuppressed, and comes back once the booking
  system lists it under an address nobody erased, or an admin allows the address on consent.
- A staff account's coach who shares an address with an erased member stays linked to the staff
  account, with its classes, at every load until the account is deactivated.
- A plus-tag spelling of an erased address is the same address to rule A (folded); a later list
  listing it under a new ref is not dropped (suppression is by exact address). A dotted spelling is
  a different address everywhere.
- A row waiting as `several_people` on the erased Person's address stays (it may be the other
  Person's) and the result counts it (`keptWaiting`); its listed name and address stay with it.
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
their address staff-linked to another Person; "the rule" (A.2: a family in To match as
`shared_address`, erasing the parent then the child; B: a husband staff-linked under his wife's
address, her later row matched; three people on one address; a row waiting as `several_people`;
C: the block with nothing of theirs; two erases on one address and consent), each scanning the
copy's three tables right after the erase; consent to come back; a numeric ref beside unrelated
text; a coach linked to a staff account; a coach's name in class titles and a class type; a lost
salt refused by a load, a link and a re-apply; merge, an erase of the merged-away Person, then of
the survivor; purge; `erasure.reapply`; removal's who (balanced and autonomous presets, every
non-human actor, Code Mode) and what is kept. `packages/core/test/outside-bounds.test.ts`: an
erase over a copy of 20 and of 6,000 people costs no more statements at the larger, none binding
over 100 or compounding over 5 terms; removal at both sizes stays within its bound; a copy bigger
than one call's passes resumes, each call within the bound, with nothing reading or linking the
rest between calls; finishing by a call or the daily maintenance leaves a list loaded since
untouched. `erase-stores.test.ts` seeds the copy into the every-store erase.
