# ADR 0922: The outside copy: what is kept, matching by address with no merge, links by hand, and suppression on erase

Status: accepted, 2026-11-24 (stage 65 build, step 3). Builds on ADRs
[0920](0920-the-booking-system-contract.md) (the booking-system contract),
[0921](0921-no-named-connector-and-a-file-source.md) (a file first),
[0247](0247-duplicate-rules-and-scan.md) (the same-address rule),
[0692](0692-one-person-per-folded-address.md) (folded addresses),
[0320](0320-erase-reaches-every-store.md) (the erased-address list),
[0402](0402-staff-and-customers.md), [0244](0244-visibility-enforced-at-one-seam.md) (the seam) and
[0449](0449-permissions-granted-one-by-one.md). Spec:
[stage 65](../stages/65-booking-system-connection.md).

## Context

A business keeps its booking system for months beside the new system. What it knows about its
members (who they are, their memberships and passes, the timetable and who is booked) reaches the
host only as lists read through the read-only contract (ADR 0920): first a file the business
exports and staff load (ADR 0921). Several packs and core use it (members' prices, a members'
program, My account, Bookings' blocks, the roster), and the rules about it (who counts as a member,
what a customer may see, what is kept and for how long) are the host's. So core keeps the copy, not
a pack, and the copy must never become the business's own records, never be merged into them, and
never decide anything on an address alone.

## Decision

**Core keeps a copy, in its own tables, read only through `outside.*`.** Migration 1410 adds
`core_outside_settings` (one row), `core_outside_list`, `core_outside_person`,
`core_outside_membership_type`, `core_outside_membership`, `core_outside_class_type`,
`core_outside_class`, `core_outside_booking`, `core_outside_staff`, `core_outside_match` and
`core_outside_suppressed`. They are in no `rec_*` view, so no `query.sql`, export, search, dashboard
or AI record read reaches them (the `core_` prefix is refused by the SQL validator). No `x_*` table,
no `core_write_guard` kind, no behaviour, and no foreign key to `core_person` or `core_user`: erase
and merge remove an outside row themselves (step 10), and a link is a ref to a Person, nothing more.

**A load replaces its kind, planned through the contract** (`packages/core/src/outside/ingest.ts`).
`readMembers` and `readTimetable` read any `BookingSystemSession` (the file source's, the fake's, a
system connected later) within the contract's limits; `planMembers` and `planTimetable` plan one
batch that marks the previous list of the kind `replaced`, writes the new `current` list (export
date, who, when, counts only), deletes the copy's rows of that kind (one statement per table) and
inserts the new ones set based, 100 rows a statement as one `json_each(?)` parameter. A plan over
900 statements is refused before anything is written (`outside_list_too_big`), leaving the
operation that runs it room under D1's 1,000. Rows not in
the new list go, with their links and matches; a staff link is carried by ref. The fixture (a
members list of 3,000 rows with 800 members, a timetable of 28 days of 15 classes with their
bookings) loads in about 34 and 69 statements (the cost test holds both under 250, with no
statement binding over 100 parameters). Step 4's `outside.file.load` runs the plan as its batch.

**What is kept is the least the first wave uses.** An outside person is kept only while they are a
member (the booking system says so, or they hold a live membership), hold a live pass, are booked in
the current timetable, or are staff-linked (`why_kept`); anyone else in the list is dropped at
load. A person is a ref, an address (normalised) and its folded form, given and family name, member
status and active; never a phone, a postal address, a birth date, a card, a note, a sale or a
price. Text is cut at 500 characters. Only kept people's memberships and passes are written. A
timetable keeps classes (with their location's name), the bookings of those classes and the
coaches; whoever is booked is named only by the members copy.

**Matched by address, never merged** (`outside/match.ts`, the contract's `matchPeople` for the
rules). At each load, for each kept outside person, in order: a suppressed ref or address, or an
address on the erased-address list, keeps nothing; a link already held is kept (a staff link
whatever the address, a link by address while its Person still holds the address); exactly one
live Person holding the address, and no other kept outside person sharing it, links (`address`);
several Persons, or several outside people on one address, link nobody and wait in To match
(`core_outside_match`, with the candidates); no Person leaves them unlinked. "The same address" is
the folded form (ADR 0692): `a+gym@x` and `a@x` are one address for matching, so two Persons holding
them wait for staff, and the exact address is kept beside it. A link by address changes nothing on
the Person (no name, address, phone or customer account; nothing sent) and adds one timeline
activity, "Linked to the booking system's list", naming no address. Coaches are matched the same way
to active human staff accounts by their exact address.

**A Person who appears later is linked then.** `person.create`, `person.update` (whenever the
addresses are written), `person.restore` and `import.csv.commit` call `matchPersonAddresses`, for
any number of Persons at once: an unlinked outside person with one of the
Person's addresses, sharing it with no other, is linked by the same rule, or waits if another
Person holds it too; a link by address to this Person whose address it no longer holds is dropped
and matched again at the next load. One indexed read when no list holds the addresses, however many Persons an import writes; the
activities are written set based. Nothing is linked this way while the copy is off, or for a ref
staff unlinked. A customer's first sign-in creates its Person through `person.create`, so signing
up links. A staff link to a Person in the Trash, erased or merged away, is no link: the next load
matches the outside person again, and `outside.status` counts only links to live Persons.

**Staff link by hand, and unlink.** `outside.link` (an outside person to any live Person, or a coach
to an active staff account) and `outside.unlink`, each with why, a person with
`bookingSystem:manage` only (`actors: ["human"]`, never MCP, Code Mode, an extension or an
automation). Both are kept across loads by ref. An unlink is staff's "nobody here": the decision is kept by
the hash of the ref alone (`core_outside_unlinked`), so it holds across loads without keeping the
person, whose row stays only while they count for another reason (a member, a live pass, booked);
the host never links that ref by address again until a person links it, which clears the decision. The audit row keeps who and why, never the
ref (a list with no ids uses the address as the ref).

**`bookingSystem:manage`**, a core permission: admins by default, grantable one by one (ADR 0449),
never to an account with a pack's fixed role. It reads the lists' state (`outside.status`), To match
(`outside.matches`) and the settings (`outside.settings.get`); it loads and removes lists (step 4)
and links. An AI may read the state and To match for an account that holds it, to explain them; it
never loads, removes, links or changes settings. The settings stay a human admin's
(`outside.settings.update`, `settings:manage`): on or off, the member types (by default every type
of kind `membership`, no pass), the two links (https only, shown as is) and the largest age (31
days by default, 1 to 90).

**A list is as old as its file.** Each list carries its export date (never after today); its age
is worked out when read, in the business's zone (and a membership is live by the business's day
too), and a members list past the largest age is shown
"too old to count" (`outside.status`), so no cron is needed for it.

**The verified-address rule** (applied by step 6, decided here so the copy is built for it): a
customer benefits from a link only when the outside person's address is their verified sign-in
address, or the link was made by staff; staff selling to a Person see the link. A link by address
alone grants nothing.

**Suppression on erase.** `core_outside_suppressed` holds, by hash only, an erased Person's outside
ref and address; every load reads it with the erased-address list and keeps nothing of them, their
bookings included (a booking naming a person by address, `email:<address>`, too). Writing it, and
removing an erased Person's outside rows, is step 10's. **Step 10's erase gates step 4**: no
operation loads a list before `person.erase` reaches the copy, so no list is ever loaded on a host
whose erase leaves a person's data behind (ADR 0320).

## Consequences

- With no list loaded every `outside.*` read answers empty and nothing else changes; a Person write
  costs one indexed read more.
- A load reads its held links before its batch, so a link made by hand during a load can be lost;
  it is rare (a person loads, the same people link) and the link is made again.
- Someone booked in a timetable but not otherwise kept is kept from the next members load, not
  from the timetable's own load.
- Until step 10 an erased Person's outside row keeps its address and a `person_id` naming nobody
  (To match shows only live Persons as candidates). Erase is reserved (`docs/parallel-work.md`), so
  it is done there.
- Saving a list's column mapping and value maps (`core_outside_settings.mappings`) is step 4's,
  with the file source's operations; a Person's outside panel (`outside.person`) is step 5's.

## Amended 2026-11-26 (stage 65 step 10, [ADR 0926](0926-erase-merge-and-removal-of-the-outside-copy.md))
- **Suppression is by keyed hash.** `core_outside_suppressed` and `core_outside_unlinked` keep the
  deployment-salted hash (`saltedHash`, as the consent register's suppression list, ADR 0675) of
  `outside:<person|staff>:ref:<ref>` and of `outside:address:<address>`, not a plain SHA-256 of the
  ref and the erased-address list's hash of the address: a list with no ids uses the address as the
  ref, so a plain digest could be recomputed from an address. No list had been loaded outside tests,
  so nothing stored was rehashed.
- **A timetable load drops a suppressed coach** (by ref or address, or an address on the
  erased-address list) as a members load drops an outside person: no row, and their classes name
  no coach.
- **Reads hold to the current lists** (`onCurrentList`), so a removed list's rows still waiting for
  `outside.lists.remove`'s next pass are no copy.
- The consequence "until step 10 an erased Person's outside row keeps its address" no longer holds:
  erase removes it, merge moves links, purge drops them.
