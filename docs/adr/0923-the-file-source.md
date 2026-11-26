# ADR 0923: The file source: a list loaded from an exported file, by a person, as its dry run said

Status: accepted, 2026-11-27 (stage 65 build, step 4; revised the same day after the review of PR #519). Block CA. Builds on ADRs
[0020](0020-query-sql-validator-and-csv-import.md) (the stateless preview-then-commit import),
[0500](0500-recurring-a-weekly-rule-in-local-time.md) (the Worker budgets),
[0920](0920-the-booking-system-contract.md) (the contract and its file session),
[0922](0922-the-outside-copy.md) (the outside copy) and
[0926](0926-erase-merge-and-removal-of-the-outside-copy.md) (erase reaching the copy). Migration
1413 (the age notices, told once; the load's guard and the copy's version). Spec: [stage 65](../stages/65-booking-system-connection.md),
"The file source", acceptance criteria 2, 3, 9 and 11.

## Context

The first client stays on its booking system for months and there is no API connection (ADR
0921): its members and its timetable reach the host as files a member of staff exports and loads.
Such a file is the business's whole client list: full of personal data, including people who have
been erased here or will be, and written by another system that knows nothing of ours. Step 3
built the copy and the ingest; step 10 made erase reach it and holds an erased person out of every
later load. This step is the only way a file's rows enter the copy.

## Decision

**One path in.** `outside.file.preview` and `outside.file.load` (`operations/outside.ts`) call
`planFile` (`outside/file.ts`): the bytes are decoded, the header read, the mapping chosen, the
file read by the contract package's `loadFiles` into the contract's records, served by the file
session (`FileBookingSystem`) through `directSession`, read back by `readMembers` or
`readTimetable`, and planned by `planMembers` or `planTimetable`. Those plans match through
`decideMatches` with step 10's rules: `droppedOf` (which first refuses a changed salt,
`assertSuppressionSalt`) drops a suppressed ref or address and counts it (`previouslyErased`),
`keptByLink` keeps a row linked to another live Person or an active staff account, and a timetable
drops an erased coach and scrubs their full name from titles. Nothing writes the copy any other
way.

**Every address, one check, before anything is kept** (revised after the review of PR #519, S1
and S2). An address cell is cleaned first (`cleanAddress`: hidden, zero-width and
direction-changing characters and soft hyphens dropped, Unicode's compatibility form, so a
fullwidth address is the plain one, trimmed, out of quotes and angle brackets), then checked by
the host's own `normaliseCustomerEmail`, the form erased addresses and suppressions are keyed by
(`loadFiles`'s `normaliseAddress`). One check, so the file and the host cannot disagree. An address
it does not take leaves the row out, saying so without the value; a row is never kept without its
address, and no ref is ever built from an address that failed. `planMembers` holds the same rule
for any source. A timetable row's every address (the coach's, and the booked person's beside their
id, `FileLoad.bookingAddresses`) is checked against erased people before anything of the row is
kept.

**An erase between a load's plan and its write** (S3). The load reads the copy's version
(`core_outside_version`, migration 1413: the current lists, the suppressions, the erased-address
list, every link and unlink decision, as counts, rowids and times, never a value) before it reads
anything else, and its batch starts with a guard (`core_load_guard`, a trigger, as
`core_write_guard`'s, its own table since the spec allows no new `core_write_guard` kind) that fails
the whole batch when the version moved. The load then answers `conflict`, `outside_preview_stale`.
So an erase, a link or unlink, a lift or another load landing in that window is never undone.

**The file is hostile input.**
- Read by its content, never a name or a declared type (the operation takes base64 bytes and
  nothing else): UTF-8 with or without a mark, UTF-16 in either order with a mark or by its NUL
  pattern, and Windows-1252 for what is not valid UTF-8. A workbook or zip, an old Excel file, a
  PDF, gzip, a web page or XML (some systems save one as `.xls`), JSON, NULs or many control
  characters are refused, saying what the file is and to export CSV. CSV, semicolon and tab
  separated text are the allow-list.
- Limits before and while parsing: 10 MB (zod, before decoding), 20,000 rows, 100 columns, 10,000
  characters a cell, each refused the moment it is passed, naming a row and column, never a value;
  at most 500 membership types, class types, coaches or locations. Cells are sliced from the text,
  not built a character at a time, the header is read alone, and the file is parsed once a call
  (the review, M1). Measured in Node 24's V8 (the script `f519-mem.mjs`, in the PR), with every
  copy the request holds (the base64 input, its bytes, the text, the records): a 9.9 MB members
  file of 20,000 rows is 19.5 MB over the base, a 9.6 MB file of 3,000-character cells 10.4 MB, a
  9.4 MB timetable of 20,000 bookings 14.9 MB, and all three complete under
  `--max-old-space-size=64`. The review measured 224 to 289 MB for the earlier parser; decoding the
  base64 with `Uint8Array.from(binary, fn)` alone ran out of a 128 MB heap, and is a plain loop now.
  The 10 MB limit stays. Not measured in workerd itself.
- Two columns of one name are refused; so is a first row that is data (an address, a long number,
  a date or time, a number, or a name, address or id the file's rows hold): it would become the
  saved mapping (the review, M3).
- A mapping that copies a person's data into the copy's own text is refused (the review, M4): a
  column mapped to a plan's name, a class's title, its type or its location whose values hold an
  address or a phone-like number (dates and times aside), or several of which are people's names,
  addresses or ids in the file. The columns whose headers look like names, addresses or ids are
  read for this check even when they are not mapped (`watch`), and nothing is echoed. A names
  column of a file that has no column the host recognises as names is not caught.
- A value is only text. A cell starting `=`, `+`, `-` or `@` is kept as the text it is, never
  evaluated, and counted in the dry run; the copy is in no export, and the platform's CSV writer
  (`csvCell`) prefixes such text anyway. Control and direction-changing characters are dropped
  from every text kept and white space (an embedded newline) folded; longer than 500 characters is
  cut. Refs are kept printable whatever the file's ids are (`fitRef`).
- Repeated rows: a person's rows merge by ref (another address is named, the first kept), a
  repeated membership or booking is named and left out, a repeated class is a class's next booking
  in a file of bookings. Dates and times are read in the business's zone; addresses normalised as
  everywhere (`normaliseCustomerEmail`, folded for matching); no phone or postal address is read.

**The dry run is exact, and the load does what it said or nothing.** The preview writes nothing.
It reports rows read and refused with why, what would be new, changed, unchanged and removed
against the current list, who is not kept, how many are dropped as erased (and of those by a
suppressed ref), who would link (with whom) and who would wait in To match, and the plan's
statement count. Its **fingerprint** is a keyed hash (the deployment's salt) over the file's text,
the mapping, the export date, the current lists' ids and every row the plan would write with its
links and matches. The load plans again from the same input and refuses (`conflict`,
`outside_preview_stale`), writing nothing, unless the fingerprint is the same: another list was
loaded, someone was erased, a Person's address changed, the file or mapping changed. ADR 0020's
stateless rule, made strict. The counts tell a person with `bookingSystem:manage` that an address
or ref in their own file is an erased person's (`dropped`, `previouslyErased`): the spec asks for
them, and nothing else about the erased person is shown.

**Where the file lives: nowhere but the request.** The bytes are in the call's input, in the
Worker's memory while it runs, and dropped when it returns; they are never written to D1, R2, KV,
a log or the audit (`redact: ["file"]`, and the audit summary is counts), nor queued for approval:
a pending action keeps its input whole, so both operations are `neverQueued` (a new operation
property, the pipeline's): where a preset or the deploy floor would make the call wait, it is
refused (`denied`, `never_queued`), saying why (the review, S4). Between the dry run and
the load the server holds nothing: the person's browser keeps the file and sends it again. So no
kept upload can defeat an erase; an erase in between changes the plan and the load is refused. We
did not use a stored upload with a TTL: it would be a second copy of the client list, including
the erased, in a store erase would have to reach.

**Who may.** Both operations: staff audience only, `bookingSystem:manage`, `actors: ["human"]`,
`mcp: { expose: false }`. No AI actor, MCP client, Code Mode, extension or automation reaches them
under any preset.

**Saved mappings hold no person.** A mapping is the columns by header, the value maps and the date
format, saved per kind in `core_outside_settings.mappings` by a load, with a keyed hash of the
file's set of column names (`shape`), never the names, so it is used only for the next export of
the same shape. A value-map word that is an address, has six digits or more, or equals a name,
address or id in the file being loaded is refused without echoing it. The list's log row keeps the
columns only. A human admin forgets a saved mapping with `outside.settings.update`'s
`clearMappings`.

**Bounded on D1, in one transaction.** A load is the plan's statements in the operation's one batch
(a D1 batch is a transaction): replace the list, delete the kind's rows (one statement a table),
insert set based, at most 100 rows and 90 KB of JSON a statement as one parameter, and one timeline
line per Person linked (two statements a hundred). Interrupted anywhere, nothing of it is written
and the previous list stays current. The file's limits bound the plan: at the largest file (20,000
rows, every one a member linking to a Person) it is 808 statements with the guard, the call 836,
under step 3's 900 for the plan and D1's 1,000; the 3,000-row fixture is 51. Every list read at
once is read in parts of at most 90 KB of JSON (the review, M2: D1's 100 KB statement and 2 MB
string); a lookup of a small table of erased people (suppressions, the erased-address list, unlink
decisions) that would take more than four parts reads the table whole, in one. So the reads grow a
little with the file (about 25 at the largest). No statement is over 100 KB, binds a text over
90 KB or more than 100 parameters, answers more than 100 columns or has more than 5 terms in a
compound SELECT (`outside-file-bounds.test.ts`, measured locally, which enforces none of them).

**The list's age, told once.** The minute cron (`runOutsideListsDue`, in cos-runner's tick) tells
the holders of `bookingSystem:manage` (admins and those granted it, at most 500) when the current
members list is 3 days from the largest age, and when it passes it, each once per list
(`told_soon_at`, `told_old_at`, migration 1413, guarded by `IS NULL`, and a dedupe key per list);
nothing while the copy is off. It removes the lists' log rows 30 days after they ended. A quiet
minute is two reads: the list is read only once it may be due (its export date within 3 days of
the largest age by UTC's day, a day early for the business's zone), and the log check (the review,
M5).

## Consequences

- A business must keep the file until it loads; a dry run and a load are two uploads of it.
- The spec said "passes that resume" nowhere for a load; a load is one atomic batch because the
  file's limits bound it. Should a source ever exceed them, it is refused (`outside_list_too_big`)
  before anything is written, never half loaded.
- The file source's parser is the contract package's (step 1), not `import.ts`'s: the file session
  must stay pure for the runner and the CLI. Both read RFC 4180 the same way.
- Not in this step: the screens (step 5), the daily digest line for To match (issue #521), and
  editing a saved mapping through `outside.settings.update` (a load saves it, settings.get shows
  it, `clearMappings` forgets it).
