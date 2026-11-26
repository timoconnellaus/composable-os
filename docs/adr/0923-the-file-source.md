# ADR 0923: The file source: a list loaded from an exported file, by a person, as its dry run said

Status: accepted, 2026-11-27 (stage 65 build, step 4). Block CA. Builds on ADRs
[0020](0020-query-sql-validator-and-csv-import.md) (the stateless preview-then-commit import),
[0500](0500-recurring-a-weekly-rule-in-local-time.md) (the Worker budgets),
[0920](0920-the-booking-system-contract.md) (the contract and its file session),
[0922](0922-the-outside-copy.md) (the outside copy) and
[0926](0926-erase-merge-and-removal-of-the-outside-copy.md) (erase reaching the copy). Migration
1413 (the age notices, told once). Spec: [stage 65](../stages/65-booking-system-connection.md),
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

**The file is hostile input.**
- Read by its content, never a name or a declared type (the operation takes base64 bytes and
  nothing else): UTF-8 with or without a mark, UTF-16 in either order with a mark or by its NUL
  pattern, and Windows-1252 for what is not valid UTF-8. A workbook or zip, an old Excel file, a
  PDF, gzip, a web page or XML (some systems save one as `.xls`), JSON, NULs or many control
  characters are refused, saying what the file is and to export CSV. CSV, semicolon and tab
  separated text are the allow-list.
- Limits before and while parsing: 10 MB (zod, before decoding), 20,000 rows, 100 columns, 10,000
  characters a cell, each refused the moment it is passed, naming a row and column, never a value;
  at most 500 membership types, class types, coaches or locations.
- Two columns of one name are refused; so is a header row that holds an address or a long number
  (no header row: the first person would become the saved mapping).
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
stateless rule, made strict.

**Where the file lives: nowhere but the request.** The bytes are in the call's input, in the
Worker's memory while it runs, and dropped when it returns; they are never written to D1, R2, KV,
a log or the audit (`redact: ["file"]`, and the audit summary is counts). Between the dry run and
the load the server holds nothing: the person's browser keeps the file and sends it again. So no
kept upload can defeat an erase; an erase in between changes the plan and the load is refused. We
did not use a stored upload with a TTL: it would be a second copy of the client list, including
the erased, in a store erase would have to reach.

**Who may.** Both operations: staff audience only, `bookingSystem:manage`, `actors: ["human"]`,
`mcp: { expose: false }`. No AI actor, MCP client, Code Mode, extension or automation reaches them
under any preset.

**Saved mappings hold no person.** A mapping is the columns by header, the value maps and the date
format, saved per kind in `core_outside_settings.mappings` by a load (and the headers it was saved
from, so it is used only for the next export of the same shape). A value-map word that is an
address, has six digits or more, or equals a name, address or id in the file being loaded is
refused without echoing it. The list's log row keeps the columns only.

**Bounded on D1, in one transaction.** A load is the plan's statements in the operation's one batch
(a D1 batch is a transaction): replace the list, delete the kind's rows (one statement a table),
insert set based, 100 rows a statement as one JSON parameter, and one timeline line per Person
linked (two statements a hundred). Interrupted anywhere, nothing of it is written and the previous
list stays current. The file's limits bound the plan: at the largest file (20,000 rows, every one a
member linking to a Person) it is 807 statements, the call 827, under step 3's 900 for the plan
and D1's 1,000; the 3,000-row fixture is 46. Reads do not grow with the file (about 20). No query
has more than 5 terms in a compound SELECT, binds more than 100 parameters or answers more than 100 columns
(`outside-file-bounds.test.ts`).

**The list's age, told once.** The minute cron (`runOutsideListsDue`, in cos-runner's tick) tells
the holders of `bookingSystem:manage` (admins and those granted it, at most 500) when the current
members list is 3 days from the largest age, and when it passes it, each once per list
(`told_soon_at`, `told_old_at`, migration 1413, guarded by `IS NULL`, and a dedupe key per list);
nothing while the copy is off. It removes the lists' log rows 30 days after they ended. A quiet
minute is two reads.

## Consequences

- A business must keep the file until it loads; a dry run and a load are two uploads of it.
- The spec said "passes that resume" nowhere for a load; a load is one atomic batch because the
  file's limits bound it. Should a source ever exceed them, it is refused (`outside_list_too_big`)
  before anything is written, never half loaded.
- The file source's parser is the contract package's (step 1), not `import.ts`'s: the file session
  must stay pure for the runner and the CLI. Both read RFC 4180 the same way.
- Not in this step: the screens (step 5), the daily digest line for To match, changing or clearing
  a saved mapping through `outside.settings.update` (a load saves it; settings.get shows it).
