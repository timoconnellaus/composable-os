# ADR 0834: Record files: the private store, typing, metadata removal, limits and the serve check

Status: accepted, 2026-11-26 (stage 56, build step 3). Builds on
[ADR 0830](0830-note-levels-kept-out-of-every-bulk-path.md) (levels and the note scope),
[ADR 0832](0832-the-notes-permissions.md) (who changes a note, no AI with any grant),
[ADR 0833](0833-note-kinds-and-templates.md) (a kind's `files_allowed`),
[ADR 0444](0444-media-the-editor-and-the-content-pack.md) and
[ADR 0475](0475-video-and-file-media-in-stream.md) (media typing, R2) and
[ADR 0320](0320-erase-reaches-every-store.md) (the blob deletion queue). Stage 56's spec, decision 5.
Shared with Forms (stage 29) and Jobs (stage 39), which keep their files here.

## Context
Staff keep photos and documents about clients: a progress photo, an injury photo, a doctor's
clearance, before and after photos of a customer's home. Some sit on notes only a client's coaches
or the people named one by one may read. A phone's photo carries where it was taken. Every file
must be treated as hostile (it may be an HTML page called `photo.jpg`, or an SVG with a script) and
every read as sensitive. The media library is the wrong place: every staff account lists it, its
hash lookup tells anyone whether a file is held, and it serves outsiders whatever published content
shows.

## Decision
- **`core_record_file`** (migration 1233): a note's id (null while the upload waits for its note),
  its R2 key `files/<id>` (its own prefix in the deployment's bucket, `BLOBS`, never the library's
  `media/`), the uploaded name, the type, the stored size, width and height, a SHA-256 for
  integrity only (nothing looks a file up by it; nothing is deduplicated), who uploaded it, when,
  and when it was attached. No view, no search entry, no embedding, nothing in `query.sql`. No new
  binding and no new R2 bucket: the prefix is in the bucket the host already binds.
- **A file's readers are exactly its note's, at every moment.** `file.serve` reads the note through
  the seam (`loadActivity`: its level and the caller's rights now, a private activity's owner, the
  Trash) on every request, and answers the one not-found for anything else: no file, a file waiting
  for its note (its uploader included), a note the caller may not read, a note in the Trash, a
  customer, the public, no session. Nothing is cached between calls. A serve of a file on a
  `coaches` or `sensitive` note is an audit row naming the file and the note, never its name.
- **Staff only, a person only, not on MCP.** Every `file.*` operation has the default `staff`
  audience, `actors: ["human"]` and `mcp: { expose: false }`. No pack role reaches one (step 4
  opens exactly the coach's). An AI actor reads the names, types and sizes of files on `staff`
  notes it reads (the activity's `files`), never a file's bytes, and never anything of a level 2
  or 3 note; it does not upload, attach, delete or change a kind's `filesAllowed`.
- **Types from the bytes, then the whole file.** `sniffRecordFile` (`packages/sdk/src/media.ts`,
  beside the library's rule, so a client tool checks the same one): JPEG, PNG, WebP or PDF, by the
  first bytes, whatever the name or the declared type. No GIF, AVIF, SVG, HTML, HEIC, office
  document, video or empty file. The host then reads the whole file as what it starts as: a JPEG's
  segments, a PNG's chunks, a WebP's RIFF chunks, a PDF's header and `%%EOF`; a file that is not
  well formed is refused.
- **Metadata removed before the original is stored**, a byte-level rewrite with no re-encoding
  (`records/files.ts`): a JPEG keeps JFIF, its frame, tables and scans, an ICC profile and Adobe's
  colour flag, and its EXIF orientation alone in an EXIF segment of one tag (so a phone's photo
  still stands up); everything else goes (EXIF with location, camera and times, XMP, comments,
  other APPn segments, anything after the image ends). A PNG keeps its image, palette,
  transparency, colour and animation chunks and loses `tEXt`, `zTXt`, `iTXt`, `eXIf`, `tIME` and
  every other. A WebP keeps its image, alpha, animation and ICC chunks and loses `EXIF` and `XMP`
  (their flags cleared). **PDFs are stored as sent**, as the spec says: rewriting a PDF safely
  needs a full parser, and a PDF is only ever served as a download.
- **Limits, held by the host before and after the bytes arrive.** A picture at most 10 MB, a PDF at
  most 20 MB (the route reads no more than 20 MB whatever the header says), at most 20 files a
  note, at most 20 uploads waiting for their note per account, and a storage cap (a setting,
  10 GB by default, changed by a human admin with `file.storage.setCap`; `file.storage.get` gives
  the total to those who manage notes, in Settings → Notes). Before the body is read the route asks
  `file.checkUpload` with the size it was told (the note, the room, the cap); `file.upload` checks
  everything again on the stored bytes, and the batch holds the note's room, the waiting count and
  the cap at commit (`core_record_file_guard`), so two uploads at once cannot pass a limit. When an
  upload takes the files past nine tenths of the cap, admins get a notice once a day naming no file
  and no client.
- **A file is not readable until its row commits, and no object is left that no row names.** The
  bytes go to R2 after the commit (`afterCommit`); a batch that fails stores nothing. A store that
  fails after the commit deletes the row it named. An upload waits, unattached and unserved, until
  its uploader saves the note it goes with (`activity.log`'s `files`, within the day, onto a kind
  that takes files); the daily purge deletes one no note took (`purgeRecordFiles`, 100 a round,
  five rounds a day). A note with files needs no body.
- **Attached, a file stays with its note** (a trigger refuses moving it). Its note's author, or
  someone allowed to manage notes (with `notes:sensitive` for a sensitive one), adds one
  (`file.upload` with `note`) or deletes one at once (`file.delete`, not to the Trash).
- **Deleting.** Every delete of a row queues its R2 object (`core_blob_deletion`, by trigger),
  drained after the commit and by the 10-minute cron. Nothing in migration 1233 names
  `core_activity`: migration 1430 remakes that table on a fresh database, where a foreign key would
  cascade its drop into this one and a trigger or view naming it would break the remake. So the
  paths that hard-delete notes delete their files in the same batch: the Trash purge (a purged
  note's files, only if the note was in fact deleted) and erase (below). A test holds every path
  that hard-deletes activities to it.
- **Erase, until stage 56 step 7.** `person.erase` deletes the files of every note it deletes and,
  for a Person, of every note linked to them that it keeps (scrubbed, linked to others): a photo
  cannot be scrubbed of whom it shows. Rows go in the erase's batch, R2 objects through the blob
  deletion path. Nothing of an erased Person's files is left readable. Step 7 keeps an evidence
  kind's notes and files detached instead, and adds the erase preview's counts.
- **Merge** needs nothing: files hang on notes, and a merge moves the notes' links.
- **Serving so nothing runs.** `Content-Type` from the stored type; `X-Content-Type-Options:
  nosniff`; `Content-Security-Policy: default-src 'none'; sandbox`; `Cache-Control: private,
  no-store`; `Cross-Origin-Resource-Policy: same-origin`; `Referrer-Policy: no-referrer`; pictures
  `inline` and PDFs only `attachment`, under a name cleaned of paths and quotes and ending in the
  real type's extension (`x.html` saves as `x.html.pdf`). `/api/files/<id>` for the admin and
  `/api/v1/files/<id>` for a staff phone; neither works without a session, and the client-app
  binding mounts neither.
- **The audit log holds a file's id, type and size**, never its name or bytes (`auditRedact:
  ["name"]`; the changes are `restricted`, so no automation event and no AI's audit list has them).

## Consequences
- Staff can attach photos and PDFs once an admin allows files on a kind (only From the client does
  by default). The composer's file picker, the timeline's thumbnails, the staff app's upload queue
  and a customer's upload (step 6) are later work; until they are built, files are reached through
  the operations and the route.
- A crafted PDF can still be opened on a staff computer once downloaded; malware scanning is
  deferred (the spec's risks).
- The 10 GB cap is checked against the sum of the stored sizes (one index read per upload).
- A file name is text an uploader typed: shown to the note's readers, and to an AI on `staff`
  notes, never in the audit log, a notice or an error.
