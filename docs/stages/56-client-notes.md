# Stage 56: Client notes

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Data,
Customers and audiences, the visibility seam, Media), [`CONTEXT.md`](../../CONTEXT.md) (Activity,
Erase, Media, Visibility seam, Pack role, Grant, Restricted permission, Guardian, Kept acceptance),
ADRs [0015](../adr/0015-core-data-model.md) (activities linked to any record),
[0019](../adr/0019-audit-redaction-for-erasure.md) and
[0320](../adr/0320-erase-reaches-every-store.md) (audit redaction, erase reaches every store),
[0112](../adr/0112-email-calendar-sync-service.md) (private synced activities, `private_to`),
[0244](../adr/0244-visibility-enforced-at-one-seam.md) and
[0410](../adr/0410-the-seams-first-door-as-built.md) (one seam),
[0436](../adr/0436-pack-roles-and-the-door-role.md),
[0449](../adr/0449-permissions-granted-one-by-one.md),
[0600](../adr/0600-a-pack-role-and-its-grants-add-up.md) and
[0625](../adr/0625-restricted-pack-permissions.md) (pack roles, grants, restricted permissions),
[0444](../adr/0444-media-the-editor-and-the-content-pack.md) and
[0475](../adr/0475-video-and-file-media-in-stream.md) (media),
[0540](../adr/0540-the-family-link.md) (the family link),
[0553](../adr/0553-attendance-the-coach-role-moves-and-cancelling-a-class.md) (the coach role),
[0590](../adr/0590-routine-mail.md) (routine mail),
[0643](../adr/0643-health-answers-read-by-a-person-with-the-permission-every-read-audited.md)
(health answers: a person with the permission, every read audited, notices that name no one),
[0646](../adr/0646-erase-merge-and-retention-for-agreements.md) (kept acceptances and retention);
stages [43](43-practitioners.md) (authored rows, the Care pack), [47](47-pack-screens.md) (pack
screens) and 48, My account (spec on PR #311, branch `docs/stage-48-my-account`: sections and
attention kinds); `packages/core/src/operations/activity.ts`, `operations/media.ts`,
`records/media.ts`, `http/media.ts`, `packages/sdk/src/media.ts`, `visibility/index.ts`,
`visibility/guardians.ts`, `pack-roles.ts`, `pack-role-today.ts`, `principals.ts`,
`ai/embedding.ts`, `ai/summaries.ts`, `records/erase.ts`, `retention.ts`, `purge.ts`; migrations
0004, 0111, 0330 and 0380; issue [#117](https://github.com/timoconnellaus/composable-os/issues/117)
(file upload from client apps).

Status: **spec agreed** (2026-11-24: the draft's ten questions were decided as best practice under
the owner's standing rule on questions, with no interview needed; decisions 1 to 10 below). Build
may start. A new stage, numbered 56.

- **Step 1 built** (branch `feat/stage-56-note-levels`, ADRs 0830, 0831, 0832; migrations 1230 and
  1231): `core_activity.level` and the note's other columns; levels 2 and 3 out of
  `core_base_activities`, `rec_activity`, `rec_activity_link`, search, embeddings and summaries;
  the note scope in the seam (`visibility/notes.ts`, through `visibleTable(ctx, "activity")`),
  knowing the actor: no AI actor reads a kept note with any grant; `activity.log` and
  `.update` take a level (a person only above `staff`, about exactly one Person; lowering needs
  `notes:manage`); a note is changed or deleted by its author or `notes:manage`, deleted by a
  person only; a sensitive note listed locked and read with `note.open` (every opening audited);
  each read of a `coaches` note's text audited with ids (`ctx.auditRead`); kept notes' changes
  audited by field name, no automation event, hidden from an AI's `audit.list` and from a
  record's history for those who may not read them; `core_person_carer` with `carer.set`,
  `.end`, `.list`; `notes:clients`, `notes:sensitive`, `notes:manage` (admins and grants,
  restricted: never self-granted). Not in step 1: kinds and templates and every admin screen
  (step 2), the shipped pack's `team` key (with Jobs), merge moving looks-after rows (step 7),
  the digest needed nothing (it reads no activities).
- **Step 2 built** (branch `feat/stage-56-note-kinds`, ADR 0833; migration 1232):
  `core_note_kind` with the four kinds seeded (Note stays `staff` and is never retired) and
  `note.kinds.list`, `.save`, `.retire` (`notes:manage`; an AI drafts a kind's name and template
  only, waiting for a person who holds it); every note has a kind (old notes are Notes), starts at
  its kind's level and is never below its lowest (operations and triggers); a template's sections
  make the note's body, kept with their labels; Settings → Notes; the admin timeline's composer
  picks a kind, fills its template and sets the level, and the timeline shows kind and level, a
  sensitive note locked and opened with `note.open`; the "Looks after" card on the Person (step 1's
  operations); the composer blocks `web-note-composer` and `native-note-composer` over
  `@composable-os/client`'s notes entry. Not in step 2: the kind's files (step 3), evidence and
  retention settings (step 7, with the typed count), client uploads and storage totals (steps 3
  and 6); existing notes keep their level when a kind's lowest is raised.

These notes can hold health and injury details. This stage is exact about who reads each note,
records every read of a restricted one, and deletes them on erase. **It is not a clinical record**:
allied health's clinical layer is out of scope (the owner ranked that market lower), and nothing
here is designed or described as meeting any rule for health records. What a business must keep,
and for how long, is for the business to confirm with its accountant or lawyer.

## Goal

Staff keep notes and files against a person or a piece of work, and the host decides who reads
each one. A coach writes a session note after a class from a template, read by that client's
coaches and by managers and admins, not the whole front desk. A coach or manager writes a sensitive
note (an injury, a personal circumstance, a complaint) that only its author and the people the
business named one by one can open, every opening recorded. A tradesperson takes before and after
photos on a job. A client sends a document from the app or website (a doctor's clearance, a photo
of the problem). Staff share a note or a file with the client, who reads it in My account on the
website and in the app. Files are kept privately, limited in size and type, never served to anyone
the host has not allowed at that moment, and deleted on erase or when the business's retention rule
says.

## Who it is for

- **Gyms and studios first.** Session notes by coaches (what was worked on, how it went, what
  next), intake and goal notes, injury and circumstance notes kept tight, progress photos, a
  clearance letter the member sends, a program summary shared with the member. Coaches are often
  fixed-role accounts (the Bookings coach role) who reach only today's class list: they write a
  note on a person from that list without gaining the rest of the CRM.
- **Trades and services next.** Notes and photos on a job (Jobs, stage 39, not specced yet; until
  it is built, on any record, such as a deal or the customer's Person): before and after photos, a
  defect photo, a plan the customer sent, a completion summary with photos shared with the
  customer. Photos are most of the content, taken on a phone on site, often with poor signal, and
  carry the location of the customer's home in their metadata. A site's access codes are Jobs' own
  restricted field on the site, not a note.
- **Allied health: not this stage.** See "A clinical layer, not built".

## What exists today (from the code)

- **Activities are notes already.** `core_activity` (migration 0004) has types `note`, `email`,
  `call`, `meeting`, `system`, a Markdown body, an author and links to any record
  (`core_activity_links`, extension objects included). Operations in
  `packages/core/src/operations/activity.ts`: `activity.log`, `.get`, `.update`, `.delete` (to the
  Trash), `.restore`, `.listForRecord` (the timeline), `.list`, `.setPrivate`, `.getBody`; staff
  only, `records:write` / `records:read`; any member may change or delete any note today.
  `activity.proposeNote` lets an AI propose a note that always waits for a person.
- **One precedent for a staff row nobody else sees.** `private_to` (migration 0111, ADR 0112): a
  synced email marked private leaves `core_base_activities` (0111) and so the `rec_activity`
  views (0380), `query.sql`, dashboards and exports; the search triggers skip it (0111);
  `ai/embedding.ts` and `ai/summaries.ts` filter it out. Only its owner reads it. This stage
  generalises that precedent.
- **Staff scope is `all`.** The visibility seam (`visibility/index.ts`) gives every staff account
  every row; stage 14a's narrower staff scopes (not built) must extend this seam, not add a second.
- **Roles are `viewer`, `member` and `admin`** (`principals.ts`). There is no manager role today.
  Core permissions an admin may grant one by one (ADR 0449) include `agreements:health`, held by
  admins by default and by grant, a person's only (ADR 0643). A restricted pack permission (ADR
  0625) is held by admins and by grant only, never through a pack role, never granted to oneself.
- **Pack roles** (`pack-roles.ts`, ADR 0436): Bookings' `coach` reads today's classes and lists
  only (`pack-role-today.ts`, ADR 0553); a pack role reaches no core operation except by
  `packRoleReaches`. A fixed-role account may be granted a pack permission, never a core one
  (ADR 0625).
- **Media library** (`operations/media.ts`, `records/media.ts`, `http/media.ts`,
  `packages/sdk/src/media.ts`; ADRs 0444, 0475): staff upload pictures (JPEG, PNG, GIF, WebP, AVIF,
  at most 10 MB) and PDFs (at most 50 MB), typed from their bytes, kept in R2, deduplicated by
  SHA-256, listed to every staff account, served to outsiders only when published content shows
  them. **It is the business's shared library, not a place for a client's private files**: every
  staff account lists it, and `media.findByHash` tells anyone whether a file is already held.
- **No upload from client apps** (issue #117, open).
- **R2** is bound as `BLOBS`. Deleting objects after a commit goes through `core_blob_deletion`
  (migration 0330), drained after the commit and by cron.
- **Proven isolation patterns**: health answers (ADR 0643: own table, in no view, a person with the
  permission, every read audited with no value, notices that name no Person because an AI reads a
  recipient's notices); kept acceptances with a retention a human admin sets and a typed count to
  confirm a shortening (ADR 0646).
- **Stage 43** (spec agreed, step 1 built) designs authored rows kept out of `rec_*` views and a
  Care pack whose `care.note` only its practitioner reads. Clinical files are out of its scope too.

## Decided 2026-11-24 (no interview needed)

The coordinator put ten questions; under the owner's standing rule each was decided as best
practice, with the recommended answer, and none was kept for the owner.

| # | Decision |
| --- | --- |
| 1 | How coaches keep notes today is **not asked**: the draft's assumptions stand, to be checked with the business during setup |
| 2 | A coach's session notes are read by **that client's coaches, plus managers and admins**, not the whole staff |
| 3 | **Staff choose a client's coaches on the client's page.** Not worked out from bookings or programs |
| 4 | **One sensitive level**, readable only by people the business chooses one by one; every opening recorded |
| 5 | Files are **photos and PDF documents**. No videos, no office documents or spreadsheets |
| 6 | **Clients may send files** themselves from the app or the website, limited by the host |
| 7 | When staff share something, the client gets **an email saying there is something new, with no details, plus a notice in the app** |
| 8 | **Each kind of note has its own retention period**; nothing is deleted automatically until the business sets one |
| 9 | On erase, **kinds marked as evidence** (an incident or injury report) are kept for a set period, out of sight, then deleted |
| 10 | **The AI never reads** notes kept to a client's coaches or marked sensitive |

## The design in one page

- **A note stays an Activity.** No second timeline. A note gains a **kind** (Note, Session note,
  Sensitive, From the client, and the business's own), a **level** (who may read it), optional
  **files**, and whether it is **shared with the client**.
- **Three levels, decided in the host's seam:**
  1. **`staff`**: everyone on the staff, as notes are today. In timelines, search, SQL, summaries
     and the assistant.
  2. **`coaches`**: the author; the staff who **look after** the client (a list on the Person, or
     the team a shipped pack declares on a live record about them); admins; and holders of
     **`notes:clients`** (by grant: this is how "managers" read them).
  3. **`sensitive`**: the author; admins; and holders of **`notes:sensitive`** (by grant, one by
     one). Each opening is an audit row without the text.
- **Levels 2 and 3 are out of every bulk path.** Like `private_to`, they are not in
  `core_base_activities` or any `rec_activity` view, and so not in `query.sql`, dashboards or
  exports; not in search, embeddings, summaries, the digest or the assistant's reads. A person who
  may read one sees it on the record's timeline (a sensitive one as a locked row to open) and in
  the note's own read, nowhere else. Anyone else learns nothing of it, not even that it exists.
- **No AI reads a level 2 or 3 note, its count or any file's bytes**, with any grant (decision 10).
  An AI may draft a note (it waits for a person, as `activity.proposeNote` does), reads level 1
  notes as today, and never shares, changes a level, sets who looks after whom, or deletes.
- **Files are attachments of a note, kept privately.** A new core table and its own R2 prefix,
  never the media library, never deduplicated or looked up by hash. Typed from the bytes, limited
  per kind and per sender, location metadata removed from photos before they are stored. Served by
  one route that asks the host, on every request, whether this caller may read the note it hangs on.
- **Kinds carry templates**: labelled sections a person fills in (Worked on / How it went / Next
  time), the kind's default level and lowest level, retention and whether it is evidence. Admins
  keep the list in Settings → Notes.
- **Sharing with the client** is a person's act on one note about one Person: the client (and a
  live guardian, for a child) reads it and its files in the **Documents** section of My account
  (stage 48), with a **"Something new shared with you"** attention item until they open it.
  Unsharing is immediate.
- **Clients send files** into a "From the client" note on their own Person (or a child's), or on a
  record of theirs whose shipped object declares it (a job). Smaller limits, a daily count, and a
  level the business sets (default `coaches`).
- **Retention and erase**: erase deletes a Person's notes and files (R2 included, through the blob
  deletion path) except kinds marked **evidence**, which are kept detached for the business's
  period, as acceptances are (ADR 0646). An optional retention period per kind deletes old notes on
  the daily run.

### Shared pieces this stage owns, and the ones it uses

- **Owns the private file store** (record files: the table, the `files/` prefix, typing,
  metadata removal, limits, the serve check) and **the signed-in customer's upload** (issue #117).
  Forms (stage 29) owns the public-write door; its file question stores a submission's files in
  this store through its own door, and Jobs (stage 39) keeps its site photos here as notes with
  files on the job. Whichever of the three is built first builds the store; the others use it.
- **Uses** Notifications (stage 30) for the client's email and its preferences (the "shared with
  you" email is a routine message kind the host declares, not an essential one); My account
  (stage 48) for the customer's section and attention kind; stage 47 for the coach's class list
  screen in the admin; and the family link (ADR 0540) for guardians.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| A new Notes pack with its own `note` object | Notes are base records; a pack object would be a second timeline, and a pack cannot keep its rows out of SQL and the assistant: that is the seam's job |
| Files in the media library with a "private" flag | Every staff account lists the library; its hash lookup leaks whether a file is held; its serving rule is "published content shows it", the wrong question |
| Waiting for stage 14a's owner-based staff scopes | 14a decides "whose records" for whole objects; this needs a rule per note. Built in the same seam so 14a extends it |
| Hiding restricted notes column by column on every staff path | A dozen paths; keeping the rows out of the views closes them at once (stage 43 reached the same answer) |
| A client's coaches worked out from bookings | One covered class would open a member's notes to a casual coach (decision 3) |
| Several sensitive groups, each note marked for one | Harder to understand and to get right; one level with grants one by one (decision 4). Groups can come later if one level is not enough |
| Encrypting notes with a key per business | The host must read them to serve them; it adds key loss as a failure and protects against nothing the access rules do not, for now. Left for a clinical layer |
| Letting the AI read restricted notes when acting for a person who may | Makes the AI a path to text the person never opened; summaries and memory would carry it on (decision 10) |
| Videos as note files | Storage and playback cost; Stream is built for published lessons (decision 5) |

## Platform work and pack work

| Piece | Platform or pack | Why |
| --- | --- | --- |
| Level, kind and sharing on `core_activity`; levels 2 and 3 out of the base view, search triggers, embeddings, summaries, digest | **Platform** (migration, `operations/activity.ts`, `ai/`) | Must hold for every staff path and every actor |
| The note scope in the seam: who may read a level 2 or 3 note; the actor (person or AI) known to the seam | **Platform** (`visibility/`, a new `visibility/notes.ts`) | One seam; stage 43 needs the same actor knowledge |
| Looks after: `core_person_carer`, and a shipped pack's declared `team` on a record | **Platform** (core table, operations; an SDK key) | Who reads whose notes is policy |
| `notes:clients`, `notes:sensitive`, `notes:manage` | **Platform** (`principals.ts`) | Core permissions, admins and grants only |
| Note kinds and templates; Settings → Notes | **Platform** (core table, core admin screens) | Levels and retention are a human admin's |
| Record files: table, R2 prefix, staff upload and serve routes, typing shared with `sdk/media.ts`, metadata removal, limits, storage cap | **Platform** (`records/`, `http/`, `packages/sdk/src/media.ts`) | Storage and serving are the host's |
| A signed-in customer's upload over the HTTP surface and typed client (issue #117) | **Platform** (`packages/core/src/http`, client kit) | A new open write door, reviewed (ADR 0402) |
| `me.documents.*` customer reads, guardians included; the Documents section and the `document_new` attention kind | **Platform** (open operations; base-layer blocks; stage 48's vocabulary) | Opening to customers is a reviewed change |
| A Bookings coach writing and reading notes for people on today's list or whom they look after | **Platform** (`pack-roles.ts` reach) | Pack roles reach core operations only by rule |
| Erase, Trash, merge, evidence and retention for notes and files | **Platform** (`records/erase.ts`, `retention.ts`, `purge.ts`, cron) | ADR 0320 |
| Base-layer blocks: note composer with templates, file picker and camera, Documents section, Send a file (web and native skins) | **Platform blocks** (base layer) | Shared by every pack |
| Bookings: "Add note" on the class list; Programs: notes on a session in the coach's client view | **Pack** (blocks only, calling core operations as the signed-in person) | Composition |
| Jobs declaring `team` and customer upload on a job | **Pack** (stage 39) | Composition |

New behaviour: none. Two new manifest keys on an object, `team` and `files.customer`, declared by
shipped packs only.

## The model

### Words (added to `CONTEXT.md` by the build)

- **Note level**: `staff`, `coaches` or `sensitive`; who may read a note.
- **Note kind**: the business's kinds of note, each with a template, a default and lowest level,
  retention and whether it is evidence.
- **Looks after**: a staff account that looks after a Person, set on the Person or through a
  shipped pack's team on a live record about them.
- **Record file**: a photo or PDF attached to a note, kept privately and served only to its note's
  readers.

### Records

- **Note** = an Activity of type `note` with new columns: `kind_id`, `level` (`staff`, `coaches`,
  `sensitive`; default `staff`, so every existing note keeps its readers), `shared_at`,
  `shared_by`, `from_customer` (the customer account that sent it), `evidence` (copied from the
  kind at write; never changed afterwards), and `sections` (the template's filled sections as JSON,
  rendered into the body for level 1 readers' existing paths). A note may have no body when it has
  files. Its links say what it is about (a Person, and optionally a class, session, deal or job).
  A note at level `coaches` or `sensitive`, or shared, is **about exactly one Person** (refused
  otherwise), so "whose coaches" and "which client" always have one answer. Only type `note` takes
  a level; email, call and meeting activities are unchanged.
- **Note kind** (`core_note_kind`): name, default level, lowest level a note of it may have,
  template sections (label, hint, required), `evidence`, retention (none, or whole years after the
  note), files allowed, active or retired. Seeds: Note (`staff`), Session note (`coaches`),
  Sensitive (`sensitive`, lowest `sensitive`), From the client (`coaches`, files allowed). A retired
  kind keeps its notes.
- **Record file** (`core_record_file`): note id, R2 key (`files/<id>`), name, type, bytes, width,
  height, sha256 (integrity only, never looked up), uploaded by (staff user or customer account),
  created at, deleted at. Its readers are exactly its note's, at every moment.
- **Looks after** (`core_person_carer`): Person, staff account, from, set by. A shipped pack may
  declare an object's **team** (`team: { person: "<relation to Person>", staff: ["<user field>"] }`):
  the staff named on a live record about the Person count as looking after them while it is live
  (a job's crew until the job closes). Bookings does not declare one (decision 3).
- **Share seen** (`core_note_share_seen`): note, customer account, seen at. It only clears the
  attention item.

### Who may read and write (the exact rules)

Every rule below is enforced in the seam and the operations, never by a block.

| | `staff` note | `coaches` note | `sensitive` note |
| --- | --- | --- | --- |
| **Read** | every staff account with `records:read` (today's rule) | the author while their account is active; staff who look after the Person; admins; `notes:clients` holders | the author while their account is active; admins; `notes:sensitive` holders |
| **Read audited** | no | every read that returns its text: one audit row per call naming the note ids, no text | every opening, one row per note, the person's included (`auditReads`, ADR 0643), no text |
| **Shown to those who may not read** | n/a | nothing: not on the timeline, not in counts, not found by id | nothing, as for `coaches` |
| **Write a new one** | `records:write` | any staff who may write notes on the Person | any staff who may write notes on the Person: a coach records an injury privately without holding the permission, and reads what they wrote |
| **Change or delete** | the author, or `notes:manage` | the author, or `notes:manage` and able to read it | the author, or `notes:manage` and `notes:sensitive` |
| **Raise its level** | anyone who may change it | anyone who may change it | n/a |
| **Lower its level** | n/a | `notes:manage`, a person only | `notes:manage` and `notes:sensitive`, a person only; never below the kind's lowest |
| **Share with the client** | anyone who may read it, `records:write`, a person only | as for `staff` | `notes:sensitive`, a person only |
| **Any AI actor** | reads as today | nothing, with any grant | nothing, with any grant |
| **A Bookings coach (pack role)** | on a Person they look after: read; on today's class list: write, and read their own | on a Person they look after: read and write; else only their own | write; read only their own |

- **The three permissions** are core permissions held by admins through their role and by others
  only by a human admin's grant (ADR 0449), as `agreements:health` is: never through a pack role
  (ADR 0625), never granted to oneself (ADR 0625's `self_grant` refusal extended to them), and
  never holding anything for an AI actor. `notes:clients` reads `coaches` notes;
  `notes:sensitive` reads `sensitive` notes; `notes:manage` keeps kinds, changes and deletes
  others' notes it can read, lowers levels and reads kept evidence. Nobody holds one by default
  except admins.
- **"Managers"** (decision 2): there is no manager role today, so a business gives its managers
  `notes:clients` by grant. Stage 14a's roles must not hold these permissions by role.
- **The author** keeps reading their own note while their staff account is active; a deactivated
  author reads nothing. A coach who stops looking after a client stops reading that client's
  `coaches` notes on the next read, except the ones they wrote.
- **Who sets who looks after whom**: `people:link` (the family link's permission: admins by
  default, grantable), a person only, audited. A coach does not add themselves.
- **Removing a grant, a looks-after or a team place takes effect on the next read.** Nothing is
  cached across calls.

### States

A note is live or in the Trash (as today), shared or not. A file follows its note: a note in the
Trash serves no file. Kinds are active or retired. No draft state: an unsaved note is the composer's.

### Operations

| Operation | Audience | Who may | Risk | Notes |
| --- | --- | --- | --- | --- |
| `activity.log` (note: kind, level, sections, files) | staff | `records:write`; level as in the table | write | A level never below the kind's lowest; refused at 2 or 3 unless about exactly one Person |
| `activity.listForRecord`, `.get`, `.getBody` | staff | as today, plus the note scope | read | `coaches` reads audited per call; a `sensitive` note listed as a locked row (kind, author, date) to readers only, its text by `note.open` |
| `note.open` | staff | may read the sensitive note; `actors: ["human"]` | read | `auditReads`; returns the text and files' list |
| `activity.update`, `.delete`, `.restore` | staff | as in the table | write / destructive | Level changes recorded by field name |
| `note.share` / `note.unshare` | staff | as in the table; `actors: ["human"]` (an AI's request waits for a person who may) | write | One Person; files go with it |
| `note.kinds.list` / `.save` / `.retire` | staff | read: staff; save and retire: `notes:manage`; a level, evidence or retention change is a person's | read / write / destructive | An AI may draft template wording, which waits for a person |
| `carer.set` / `carer.end` / `carer.list` | staff | set and end: `people:link`, `actors: ["human"]`; list: `records:read` | write / read | Audited |
| `file.upload` (route `POST /api/files`) | staff | may change the note | write | Bytes from the route, never from input (as `media.upload`) |
| `file.serve` (route `GET /api/v1/files/<id>`) | staff, customer | may read its note now | read | `hostInternal`; a customer only for a shared note or one they sent; audited at levels 2 and 3 |
| `me.documents.list` / `.get` | **customer** (open) | their own Person, or a live dependant's | read | Shared notes and their files, and what they sent; marks seen |
| `me.documents.upload` (route `POST /api/v1/files`) | **customer** (open) | signed in; their own Person, a live dependant, or a record of theirs whose object declares `files.customer` | write | A reviewed change (ADR 0402); issue #117 |
| `notes.purgeDue` | host step | daily cron, system origin | destructive | Retention and evidence periods; at most 100 notes a round |

A Bookings coach gains through `packRoleReaches` exactly `activity.log` (notes only),
`activity.listForRecord`, `note.open` (their own), `file.upload` and `file.serve`, each limited as in
the table, and nothing else of the CRM. All customer operations are `mcp: { expose: false }`, rate
limited per account and never queued.

### Files: types, limits, serving

- **Types, read from the bytes**: JPEG, PNG, WebP and PDF. Nothing else, whatever its name: no SVG,
  no HTML, no office document, no video, no empty file. Phones' HEIC photos are converted to JPEG
  on the device or in the browser before upload; the host does not accept HEIC.
- **Limits**: staff 10 MB a picture, 20 MB a PDF, 20 files a note; a client 10 MB a file, 20 files
  a day per account. A per-deployment storage cap (a setting, default 10 GB, human admins only)
  refuses uploads past it and tells admins. Totals shown in Settings → Notes.
- **Metadata**: location, camera and other metadata segments are removed from JPEG, PNG and WebP
  bytes before the original is stored (a byte-level rewrite, no re-encoding). PDFs are stored as
  sent.
- **Serving**: never a URL that works without a session; `Cache-Control: private, no-store`;
  `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff`; pictures inline, PDFs
  only as downloads; no public thumbnails; thumbnails, when made, go through the same check. A
  refused or unknown file is the one not-found.
- **Offline photos (trades, staff app)**: a queue on the device uploads when there is signal; the
  photo is held in the app's private storage only until it is sent. Writing notes still needs
  signal.

### Screens

- **Web admin (staff, core admin screens)**: the Person timeline shows each note's kind and level
  (a lock for sensitive, opened one at a time), files as thumbnails or a download, and "Shared with
  client"; the composer picks a kind, fills its template, attaches files, sets the level and
  sharing. A "Looks after" panel on the Person. Settings → Notes: kinds, templates, levels,
  retention, evidence, client uploads and their level, storage totals and cap. A "From clients"
  list of notes clients sent that the viewer may read.
- **Bookings' class list** (a pack screen, stage 47): "Add note" per person opens the composer with
  the Session note kind, linked to the Person and the class. Programs' coach client view shows notes
  linked to a session. Neither pack reads notes itself.
- **Customer web and app (My account, stage 48)**: a base **Documents** section beside
  Agreements: shared notes and their files, what I sent, a child's for a guardian, and **Send a
  file** (picker or camera, a short message). `me.portal` lists it when the caller or a live
  dependant has a shared note or a sent file; the upload is always reachable from the section.
  The attention kind **`document_new`** ("Something new shared with you", for them or their child),
  shown until opened. Base-layer blocks, web and native skins over shared hooks.
- **Native (staff)**: "Add note" on the coach's class list; the camera with the upload queue.

### Notifications

- **A note shared with the client**: the `document_new` attention item in My account, and an email
  "Something new from the business: open your account", with no content, as a routine message kind
  the host declares (stage 30), not essential: a person may stop it and a human admin may turn it
  off. Never the note's text or a file name in any message.
- **A client sent a file**: an in-app notice to the staff who look after them (or admins if
  nobody does), naming no Person and no id ("A client sent a file"), linking to "From clients",
  which shows each reader only what they may read. ADR 0643's amendment: an AI reads a recipient's
  notices.
- **A sensitive note written**: no notice.

### What an AI may do

Every model call goes through AI Gateway by model role, as today; nothing here picks a provider.

- **May**: draft a note or a template's wording (waits for a person); read `staff` notes and the
  names and types of their files, as today; ask to share a `staff` note (a person who may approves).
- **May not**: read `coaches` or `sensitive` notes, their existence or counts; read any file's
  bytes (no file is ever sent to a model); change a level, a kind's level, evidence or retention,
  or who looks after whom; delete a note or file; upload; share without a person.
  `notes:clients`, `notes:sensitive` and `notes:manage` give an AI actor nothing.

### Privacy, audit and erase

- **Audit**: changes to `coaches` and `sensitive` notes are recorded by field name, no text (ADR
  0019's redaction at write); reads as in the table, ids only. Errors and logs carry no note text
  and no file names.
- **Erase** (`person.erase`): notes only about the Person, their files (rows at once, R2 objects
  through `core_blob_deletion`), what they sent, their looks-after rows and share-seen rows go;
  notes linked to others too are scrubbed of the Person as today. **Evidence kinds** are kept
  detached (no Person, no account, `erased_at`), unchangeable (a guard trigger), readable only with
  `notes:manage` by a person, deleted when the kind's period ends unless held for a dispute, as ADR
  0646 does for acceptances. The erase preview says how many notes and files go and how many are
  kept until when.
- **Merge** moves notes, files, looks-after and share-seen rows to the survivor.
- **Trash**: a deleted note's files are not served; the purge after 30 days deletes them from R2.
- **Retention** per kind: whole years after the note, a human admin's setting; shortening it asks
  the person to type how many notes the next daily run deletes. No period ships; each is for the
  business to confirm with its accountant or lawyer.
- **Location**: files live in the deployment's R2 bucket, which takes the location hint only at
  creation (ADR 0580). Nothing here moves an existing bucket.

### A clinical layer, not built

So that nothing here must be undone if allied health is taken on later: practitioner-authored notes
(stage 43's principal), notes locked when signed and corrected only by an addendum, reads always
audited with an access report and an export for an access request, retention held by the database
and counted from the last visit or a child's coming of age, consent per discipline, and optional
encryption per practice. The `level` column leaves room for a `clinical` level the seam routes.
Each would be for the practice to confirm with its own lawyer.

## Out of scope

- The clinical layer above; stage 43's `care.note` stays the Care pack's.
- Videos, office documents and spreadsheets, and any file the host cannot type from its bytes.
- Email attachments onto the timeline (stage 36); the public upload of a form (stage 29, using
  this store).
- Comments and mentions on notes; editing a file; versions of a file.
- Scanning files for malware (deferred; see Risks).
- Offline note writing in the staff app (photos queue; notes need signal).
- Stage 14a's owner and team scopes for whole objects.
- Several sensitive groups (decision 4).

## Acceptance criteria

1. A coach who looks after a member writes a Session note from its template on the member's page;
   a coach who does not look after them and a plain member account do not see it on the timeline,
   in search, `query.sql`, a dashboard, an export, the digest or the assistant's answers.
2. An admin and a holder of `notes:clients` read that note, and each read is an audit row with ids
   and no text; removing the grant or the looks-after removes it on the next read; the author keeps
   it while active and loses it when deactivated.
3. A sensitive note is read only by its author, admins and holders of `notes:sensitive`; each
   opening is an audit row with ids and no text; anyone else gets not found for its id and sees no
   row and no count.
4. Any member may write a sensitive note and read it afterwards; they read no other sensitive note.
5. Every AI actor (assistant, MCP, an automation's AI step) with any grant gets nothing of level 2
   and 3 notes: no text, count or file; summaries and embeddings never include them (tests over
   `ai/summaries.ts` and `ai/embedding.ts`).
6. An AI's `activity.proposeNote` and share request wait for a person; an AI cannot lower a level,
   change a kind's level, evidence or retention, set who looks after whom, or delete a note or file.
7. A Bookings coach (pack role) writes a session note on a person on today's class list, reads
   `coaches` notes of people they look after, and reaches no other core operation; they cannot be
   granted a notes permission.
8. Nobody grants themselves a notes permission; granting one is a human admin's, audited.
9. A picture over 10 MB, a PDF over 20 MB, an SVG, an HTML file renamed `.jpg`, a HEIC file and an
   empty file are refused, typed from the bytes; a JPEG with GPS metadata is stored without it.
10. A file is served only to a caller who may read its note now: a URL copied to another session, a
    signed-out browser or a customer of another Person gets the one not-found; a file of a note in
    the Trash is not served; level 2 and 3 serves are audited.
11. Record files are never listed by `media.list` and never found by `media.findByHash`.
12. Staff share a note about one Person: the member reads it and its files in the Documents
    section on the web and in the app, with a `document_new` attention item until opened; a live
    guardian reads a child's; unsharing hides it at once; a note about two People cannot be shared;
    the email names nothing of the note.
13. A member sends a file from the app; it lands as a From the client note at the configured level
    (default `coaches`); the daily count, size limits and storage cap are enforced by the host; the
    people who look after them get a notice naming no one.
14. Erasing a Person deletes their notes, files (R2 objects within the blob deletion path's window)
    and sent files; evidence kinds are kept detached, unchangeable, readable only with
    `notes:manage`, and purged after the period unless held.
15. A retention period on a kind deletes notes and files past it on the daily run, at most 100 a
    round; shortening it requires the typed count.
16. Merge moves notes, files and looks-after; the Trash purge deletes files from R2.
17. The audit log holds no note text of level 2 or 3 and no file bytes or names; errors hold no
    values.
18. A runtime extension declaring `team` or `files.customer` is refused by `cos ext check` and at
    install.
19. `me.documents.*` and the customer upload are in `open-operations.json`; a public caller gets
    not found.
20. Statement-count tests bound the timeline read with the note scope, `file.serve` and
    `me.documents.list`.
21. E2E, one per journey: a coach's session note from the class list; a member sends a file; staff
    share a note and the member reads it.
22. The site and `SITE.md` describe notes and files if the site lists them.

## Dependencies

- Built: stages 22, 23, 24 (audiences, HTTP surface, client apps), 28 and 42 (media typing
  reused), 31a (family link, coach role), 44 (ADRs 0643, 0646), 45 (restricted permissions).
- Stage 47 (spec agreed, building on PR #303): the class list's note in the web admin.
- Stage 48, My account (spec on PR #311): the Documents section and the `document_new` kind; until
  it is built, step 5's blocks stand alone and move into its shell when it lands.
- Stage 30, Notifications (not specced as agreed yet): the host-declared routine message kind for
  the "shared with you" email. Until it is built, sharing shows the attention item and sends no
  email; no stand-in mail is built.
- Stage 43 (spec agreed, step 1 only): not needed; the seam's actor knowledge is shared work, so
  whichever lands first builds it and the other uses it.
- Stage 39, Jobs (not specced as agreed): trades use any record until it exists; Jobs declares
  `team` and `files.customer` and keeps its photos here.
- Stage 29, Forms (not agreed): its file question uses this store.
- Stage 14a (not built): must extend this note scope, not replace it.

## Migrations and numbers

Block **BR**: migrations 1230 to 1249, ADRs 0830 to 0839 (the coordinator records the claim in
`parallel-work.md`). Expected migrations: 1230 (note columns on `core_activity`; `core_base_activities`,
the `rec_activity` views and the search triggers remade to exclude levels 2 and 3), 1231
(`core_note_kind` and its seeds), 1232 (`core_person_carer`), 1233 (`core_record_file`), 1234
(`core_note_share_seen`), 1235 (the evidence guard and holds). ADRs the build writes:

- **0830**: Note levels: three levels, levels 2 and 3 kept out of every bulk path, the note scope in
  the seam and the actor it knows (generalises ADR 0112's `private_to`; stage 43's authored rows
  cite it or amend it).
- **0831**: Looks after, and a shipped pack's declared team.
- **0832**: The notes permissions: `notes:clients`, `notes:sensitive`, `notes:manage`; who writes,
  reads and changes what; reads audited; no AI with any grant (amends ADR 0625 for the
  `self_grant` rule on core permissions).
- **0833**: Note kinds and templates.
- **0834**: Record files: the private store, typing, metadata removal, limits and the serve check
  (shared with Forms and Jobs).
- **0835**: A signed-in customer's upload (closes issue #117), `me.documents.*`, the Documents
  section and the `document_new` attention kind (amends stage 48's ADR on attention kinds with a
  dated note, if merged first).
- **0836**: Erase, merge, evidence kinds and retention for notes and files (builds on ADR 0646).

## Suggested build order

| Step | What | Files or areas | Can be built beside |
| --- | --- | --- | --- |
| 1 | Levels and kinds' columns, looks after, the three permissions; base view, search triggers, embeddings, summaries and digest exclude levels 2 and 3; the seam's note scope and actor; read audits | `packages/db` migration on `core_activity`, `visibility/`, `operations/activity.ts`, `principals.ts`, `ai/` | **Alone in its window.** Collides with stage 43's seam steps, stage 14a, anything touching activity triggers or `rec_activity` (email sync), and the erase-completeness area |
| 2 | Note kinds and templates; Settings → Notes; the composer block | core table, `operations/`, `apps/app` settings, base-layer blocks | Step 3; any pack work |
| 3 | Record files: table, R2 prefix, staff upload and serve routes, typing shared with `sdk/media.ts`, metadata removal, limits, cap, Trash and purge | `records/`, `http/`, `packages/sdk/src/media.ts`, `purge.ts` | Step 2. **Collides** with media work (Content, Courses) on `sdk/media.ts`, and with Forms step 8 or Jobs' attachments if either starts the store first |
| 4 | Coaches: pack-role reach, Bookings' class list "Add note", Programs' session notes, the coach app | `pack-roles.ts`, `packs/bookings`, `packs/programs` blocks | Steps 5 and 6. **Collides** with anything on `pack-roles.ts` and stage 47 step 4 |
| 5 | Sharing and Documents: `note.share`, `me.documents.*`, guardians, the attention kind, the section blocks | `operations/`, `visibility/guardians.ts`, base-layer blocks, stage 48's attention code | Steps 4 and 6. **Collides** with stage 48 steps 4 and 7 (`me.attention`, account blocks) |
| 6 | The customer upload (issue #117): open route, limits, daily count, `files.customer`, typed client upload | `packages/core/src/http`, client kit, `packages/sdk/src/manifest.ts`, `open-operations.json` | Steps 4 and 5. **Collides** with typed-client generation, the API golden files and `manifest.ts` changes |
| 7 | Erase, merge, evidence kinds, retention, holds, the erase preview | `records/erase.ts`, `retention.ts`, cron, a guard trigger migration | After 3. **Collides** with any erase work |
| 8 | The "shared with you" email kind | routine messages | After stage 30's host-declared kinds |
| 9 | Site and `SITE.md` | `apps/marketing` | Last |

**Size: large.** Step 1 is one session alone (it touches every staff read path). After it, up to
three sessions at once (2 and 3; then 4, 5 and 6), and step 7 once 3 is in.

## Decided by this spec, open to override

Decided as best practice (the coordinator's list, 2026-11-24, recorded as decisions 1 to 10 above),
and these points the spec decided the conventional way:

- Notes stay Activities; files hang only on notes (a file with no words is a note with no body).
- Admins read every level by their role, as every restricted permission works; others read
  `coaches` and `sensitive` notes only by a grant one by one, or `coaches` notes by looking after.
- "Managers" read client notes through a `notes:clients` grant, as there is no manager role.
- The author always reads their own note while their account is active; any staff writer may write
  a sensitive note.
- A Bookings coach reads the `staff` and `coaches` notes of people they look after, and only their
  own notes about others on today's list; a fixed-role account cannot be granted a notes permission.
- `coaches` reads are audited per call and `sensitive` openings one by one; file serves at levels 2
  and 3 are audited.
- Who looks after whom is set with `people:link`, a person only; coaches do not add themselves.
- A note at level 2 or 3, or shared, is about exactly one Person.
- Files a client sends land at `coaches` by default (a clearance letter is health information),
  changeable by a human admin to `staff` or `sensitive`. The draft's default was `staff`.
- JPEG, PNG, WebP and PDF only; HEIC converted before upload; staff limits 10 MB a picture and
  20 MB a PDF; clients 10 MB a file and 20 a day; a storage cap of 10 GB by default.
- Location metadata removed from every photo; PDFs stored as sent.
- Sharing is a person's act; the email waits for stage 30 rather than a stand-in.
- No notice when a sensitive note is written.
- Erase deletes everything except evidence kinds; no retention period ships.

## Questions for the owner

None. Every point was a best-practice decision; the business's own note habits, limits and levels
are checked at setup (decision 1).

## Risks

- **Privacy**: step 1 must find every path that reads activities (timeline, search, SQL, exports,
  digest, summaries, embeddings, assistant tools, audit values, notifications, the Trash list); a
  missed one leaks sensitive text. The one-seam test and a path-by-path isolation test, as ADR
  0643's, are the guard, with a security review before merge.
- **Security**: files from customers are untrusted. Typing from bytes, the sandbox header and
  download-only PDFs reduce but do not remove the risk of a crafted PDF opened on a staff computer;
  malware scanning is deferred. The customer upload is a new write door: rate limits, the daily
  count and the storage cap are its guards.
- **Cost**: R2 storage per client, measured per client on hosted deployments (stage 46).
- **Real devices**: the camera, HEIC conversion, metadata removal on real phone photos and the
  offline photo queue need real iPhones and Android phones.
- **Overlaps**: stage 43's authored rows and this stage's levels are two designs for "rows staff may
  not read in bulk"; ADR 0830 should be the one both cite. Jobs' draft calls its photos "record
  attachments read by whoever may read the record"; here they are notes with files on the job
  (level `staff` gives exactly that), and a Jobs private link for customers without an account
  must ask `file.serve`'s same check.
