# ADR 0495: The courses import

Status: accepted, 2026-11-22 (stage 42, build step 8: `cos courses import`, `feat/courses-import`).
Builds on ADRs [0470](0470-the-import-door.md) (the import door),
[0475](0475-video-and-file-media-in-stream.md) (video in Stream),
[0477](0477-the-access-scope.md) (the access scope) and [0478](0478-the-courses-pack.md) (the
Courses pack). Amends ADR 0470.

## Context
The first client sells courses on a hosted course platform. Moving it means moving each course with
its outline, its videos (large files, or links Stream can copy), captions, pictures and downloads;
the bundles; and each student's access, the courses they finished and their lesson-by-lesson
progress. The owner decided (stage 42's interview):
- people and access move, and completed courses move;
- per-lesson progress moves when the platform exports it;
- without such an export, completions are imported and the report names the courses that had
  nothing to bring;
- unmatched rows are listed with their file and line, and the rest imports;
- a student's own progress since the import is a conflict and is kept.

`cos content import` (ADR 0470) already had the shape: a folder checked whole before signing in, a
person's session for the run, `record.import`'s dry run, import keys, conflicts reported, and
publishing as the person's choice. The coordinator's brief was to reuse that engine, not write a
second one.

## Decision

**The generic half of the content import is lifted into `import-door/`**
(`packages/create-composable-os/src/import-door/`), and both commands use it:
- `host.ts`: the `ImportHost` (calls, uploads, caption uploads, sends to an outside address) over a
  signed-in session;
- `sign-in.ts`: the run's sign-in, by code or browser loopback, and the `--publish` confirmation;
- `records.ts`: `record.import` in batches of 25 with its outcomes, the media already in the
  library by hash, SHA-256, and the report's outcome lines.

`content-import/` keeps its folder format and its order of writes. Its behaviour is unchanged, and
its tests pass unchanged.

**`cos courses import <folder> --host <url>`** (`courses-import/`). `format.ts` is pure and checks
the folder: courses and bundles as JSON, videos by file or `https` address, captions (WebVTT, or
SubRip converted), pictures, downloads, `access.csv` and `progress.csv`. Each problem has its file,
and for a CSV row its line. `engine.ts` runs the import:
1. Each student is found by email, and each session lesson's program by id or exact published
   title.
2. A dry run of every theme, course and bundle on the host, with placeholders for media not yet in
   the library.
3. The uploads.
4. A wait for Stream.
5. The records: themes; then courses whose videos are all ready; bundles whose courses are all
   written; enrolments; progress.
6. With `--publish`, publishing.

`docs/importing.md` defines the format.

**A student is found by email, and is never created.** The row's address, lowercased, must be the
one live person on the host with it (`person.list`, the `emails` field). People come first through
the people CSV import (ADR 0102), whose match is "same email".
- No such person (never imported, or an erased address): the row is listed and nothing is made.
- More than one: this cannot happen today, since `person.create` refuses an address already held.
  If it did, the row would be listed ("merge them first") and not guessed.

The import sends no mail.

**Access is enrolments with source `import`, never orders.** Each access row is a
`courses.enrolment` keyed `<email>|course:<key>` (or `bundle:<key>`), carrying `from`, `until` and
`completed`, through `record.import`. The host sets the enrolment's `code`. No order is made for
money taken elsewhere. An `until` in the past is kept, so a lapsed student stays lapsed.

**Progress is matched by the lesson's `sourceId` and keyed `<email>|<course>|<sourceId>`**, so a
lesson moved to another section in the new outline keeps its progress. Two cases are reported, not
written:
- **A row whose `sourceId` no lesson has** is listed with its line.
- **A student's own row for that lesson** (source `self`, which the pack's `progress` tool writes)
  is a conflict. It is found before writing by listing the course's progress whose source is not
  `import`, and it is kept. An imported row the student has since changed is a conflict by
  `record.import`'s own rule. Neither is ever overwritten.

**Videos: one upload, found again by hash, and a course is not written until its videos are
ready.**
- **`media.videoUpload` takes an optional `sha256`**, the file's SHA-256 worked out by the command
  as it streams the file from disk. The video's row keeps it (`core_media.sha256`, the column
  migration 0501 added for pictures), so `media.findByHash` finds it on a re-run.
- **`media.videoFromUrl`** (new) has Stream copy a video from an `https` address (Stream's copy from
  a link). Its row keeps the SHA-256 of `url:<address>`. The address is only ever fetched by
  Stream, never by the host. The operation is `actors: ["human"]` and not on MCP.
- **Large files go in tus chunks with progress.** A failed chunk asks Stream for its offset
  (`HEAD`) and carries on from there, up to five times in a row. A video a stopped run left
  `uploading`, or one Stream marked `failed`, is deleted and sent again from the start on the next
  run. Stream's one-time address is not kept between runs, so resuming across runs is not built.
- **The command waits for Stream** (`--wait <minutes>`, 10 by default, polling `media.videoRefresh`)
  and writes only the courses whose videos are all `ready`. It cannot publish a course with a
  video no one can play, so it writes nothing it would have to hold back. Each course still waiting
  is named, and the command exits 3. Running the same command again finds the videos by hash and
  writes those courses. A bundle waits for all its courses.

**Captions: a staff-token caption route.** `POST /api/v1/media/<id>/captions?language=&label=` is
the token twin of `/api/media/<id>/captions`, as `POST /api/v1/media` is of `/api/media` (ADR
0470). It takes a staff device token and nothing else (no cookie), refuses any actor but `human`,
and calls `media.captionUpload`. It is on only where `tokenUploads` is. It sits under
`/api/v1/*`, so a host behind Cloudflare Access needs no new path.

**No new migration.** `core_media.sha256` already existed (0501). Block AH (migrations 0550 to 0559,
ADRs 0495 to 0499) is claimed, and only ADR 0495 is used. (Block AG went to stage 32 first.)

## Proof
- `apps/app/test/courses-import.test.ts`, 8 tests against the real host (handleApi, the media
  routes with `tokenUploads`, a staff device session) with the fake Stream served at the host's
  `fake-stream` path. No payment provider is set up, because the import calls none; the test
  checks that the students have no orders:
  - a bad folder stops before any write;
  - a dry run writes nothing;
  - the folder imports: two courses (file and link videos, SubRip captions, a download, a session
    lesson on a published program), a bundle, four enrolments with source `import` and no order,
    a completed course, and progress;
  - the unmatched rows are listed (an unknown person in each CSV, a dropped `sourceId`), and the
    note for a course with nothing to bring;
  - an imported student plays a lesson, so does one holding the bundle, and a person without
    access and a lapsed one cannot;
  - a re-run creates, updates and uploads nothing, and the publish is unchanged;
  - a student's own progress, and an imported row they changed, are conflicts and are kept;
  - a course whose video Stream has not finished is not written, and a re-run writes it with no
    upload;
  - no AI actor (assistant, MCP, automation) can run `record.import`, `media.videoUpload` or
    `media.videoFromUrl`; `media.videoFromUrl` refuses `http`; the caption token route without a
    bearer token is 401.
- `packages/create-composable-os/test/courses-import.test.ts`, 8 tests:
  - CSV parsing and line numbers, and SubRip to WebVTT;
  - a good folder's plan, and every folder problem with its file and line;
  - a dropped `sourceId` is the import's report, not a folder problem;
  - reading from disk;
  - tus chunks resumed from Stream's offset after a dropped connection, with progress;
  - the command stops before signing in on a bad folder or no `--host`.
- `packages/create-composable-os/test/content-import.test.ts` passes unchanged on the lifted code.

Each check removed, tests fail (restored after; tests of `apps/app/test/courses-import.test.ts`):

| Check removed | Tests that failed |
| --- | --- |
| `media.videoFromUrl` is `actors: ["human"]` | 1 (no AI actor) |
| `media.videoFromUrl` takes `https` only | 1 (no AI actor, the `http` refusal) |
| The caption token route needs a `Bearer cos_at_…` token | 1 (no AI actor, the 401) |
| A student's own progress is kept (the `self` rows read before writing) | 1 (own progress kept) |
| A row with no person is reported (dropped silently instead) | 1 (the import) |
| A row whose `sourceId` no lesson has is reported (written instead) | 1 (the import) |
| An enrolment keeps its `until` | 1 (a lapsed student cannot play) |

`record.import`'s and `media.videoUpload`'s `actors: ["human"]` are ADR 0470's and 0475's checks,
which their own mutation tables cover. The new test also covers them for AI actors. The caption
route's second check (a token whose context is not a human's) has no test that can reach it: a
staff device session is only ever a person's, so the check is a second line behind the first.

## What never ran
- **Real Cloudflare Stream.** Every upload, tus chunk, copy from a link, caption and readiness poll
  ran against the fake Stream. Stream's copy from a link is not tried against a real Vimeo or
  Wistia address, and no multi-gigabyte file was sent.
- **A real export from the old platform.** No export of the first client's school was read. The
  folder format follows the stage's research and the owner's answers. The converter from the real
  export is the first client's work (build step 9), after the two-programs checklist in
  `docs/stages/42-courses.md`.
- **The browser sign-in from the courses command.** It is the content import's code, unchanged,
  and was not run against a real host here.

## Consequences
- A client with courses on another platform has one command and one format. A later import
  (stage 12's CRM, events) has a lifted door (`import-door/`) to build on, and needs no third
  engine.
- A course may be in Stream but not yet on the host for as long as Stream takes. The command says
  so and exits 3, and a scheduled re-run finishes it.
- An interrupted upload of a very large file starts again from the beginning on the next run.
  Keeping Stream's tus address between runs (it lasts as long as Stream allows) is a later
  improvement, if the first client's files make it worth it.
