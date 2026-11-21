# ADR 0478: The Courses pack

Status: accepted, 2026-11-22 (stage 42, build steps 4, 6, 7 and the assistant's draft of step 8).
Builds on ADRs [0475](0475-video-and-file-media-in-stream.md) to
[0477](0477-the-access-scope.md) (the spine), [0479](0479-tax-at-checkout.md) (tax at checkout),
[0480](0480-an-ai-asks-to-publish-a-person-approves.md) (publish requests),
[0435](0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md),
[0448](0448-programs-the-layout-assignments-and-the-log.md) and
[0453](0453-pack-hooks-over-the-clients-operations.md).

## Context
The spine gave the host videos, signed playback and the access scope. This step is the pack the
studio sells with: courses and bundles, the enrolments a paid order grants, lessons and progress,
session lessons on Programs, the staff side, hooks and blocks, and the assistant's draft. What the
pack could not express, the host gained, and that is recorded here with the pack.

## Decision

### The pack (`packs/courses`, `@composable-os/pack-courses`)
- **Objects.** `courses.theme` (public, every live one); `courses.course` (publishable with a
  public half; `sellable` with a sale window, the tax code `txcd_20060158` (on-demand online
  courses, no place) and a grant of one enrolment; `access` from enrolments of the course or of a
  bundle that lists it); `courses.bundle` (publishable, public, sellable with the same code,
  granting an enrolment of the bundle; its courses are refs in a document, two to ten);
  `courses.enrolment` (its student, course or bundle, order, where it came from, reason, from,
  until, imported completion; states `active`, `ended`, `void`, where only the host moves to `void`,
  on a full refund); `courses.progress` (one row per student and lesson: started or done, when,
  the video's position, where it came from).
- **The outline** (`outline.ts`, `OUTLINE_SCHEMA`) is one document of sections of lessons, each one
  kind: `video` (a ready video and rich text notes), `text`, `session` (a Programs program, a week
  and a session of it, and an optional video) or `download` (a file). Every lesson has a key (lower
  case words, never changed by the builder's edits, which progress is kept by), a title, minutes,
  a free-preview flag and the id it had on the old platform. Its material is `holders: { keys,
  unless: "preview" }`: removed by the seam for everyone without access, and its video played only
  to a holder. Rich text's own schema is used inside it (its definitions merged into the
  outline's).
- **The precondition was not met.** The client's real programs could not be read from here; the
  owner's answer stands in (a program is lessons, each a video and some text, sometimes with a
  training session to follow), and the outline is built to it. What to check against two real
  programs before the first client's import is listed in the spec's as-built notes.
- **Tools** (`x.courses.*`): `catalogue` and `course` (customer, public; read through
  `public.list`); `lesson`, `progress`, `myCourses`, `startSession` (customer; `lesson` staff too);
  `buy` (customer, public: `order.start` for one line, refused as not there for a course the caller
  already holds); `enrol` and `endEnrolment` (staff, permission `courses:enrol`, grantable);
  `stats` and `draft` (staff). None holds a rule: whether the caller holds a course is the host's
  answer (`access.check`), what a lesson shows is what the seam gave, and progress is refused by
  the host without access.
- **Staff side.** Views (published courses, drafts, enrolments this month, imported enrolments),
  the Courses dashboard (revenue by month per course and bundle, enrolments by course, lessons
  done, imported completions, students with nothing done in two weeks), and the Person page's
  Courses and Lessons tabs. Revenue is what buyers paid, tax inside it; net of tax is one change
  of SQL once ADR 0479's columns are read.
- **Hooks** (`client/index.ts`, `COURSES_HOOKS_CALL`, ADR 0453): a public client gets the
  catalogue, the course page and buying; a customer's also lessons, playback, progress, their
  courses and session lessons; staff the builder's hooks and enrolments. `usePlayback` asks
  `media.play` again five minutes before the token expires. The builder's edits are pure
  (`outlineEdits`) and never change a lesson's key.
- **Blocks.** Web: catalogue, course page (buy on the web), player (video with resume, rich text,
  download, session; mark done; next), my courses (with progress), and the course builder (staff;
  lessons moved by buttons, so by keyboard). Native: catalogue, course, player (the device player
  is a prop), my courses. Every native block is `noPurchase`.

### How a pack tool gets a playback token: through the host, by the app
`lesson` does not sign anything. It names the video and where it is shown (`{ media, record,
field }`), and the app calls `media.play` with that, over its binding or the HTTP surface, where
cos-app signs the token (`usePlayback` does it). So the signing key is in one Worker, cos-app, and
cos-runner (where tools run) holds no Stream credential. The other way (the secrets on the runner
too) would put the key in two Workers and widen what a sandboxed tool's host can do; and the
token has to be asked for again before it expires anyway, which the hook does, not the tool.

### What the host gained
- **An extension may require another** (`requires: ["programs"]`, ADR 0478): the install check
  refuses it, first among its issues, while one it requires is not installed and on; shipped
  extensions already install in two passes, so Courses installs after Programs. `cos ext check`
  reconciles a required neighbour first and counts it installed.
- **A customer's write may need access** (`customer.requireAccess: ["course"]`): the seam's write
  helpers refuse a create or an update of the caller's own record unless they hold access (the
  seam's one question) to what its relation points to, after the write. Progress is written only
  while the course is theirs.
- **`access.check`** (tool-only; staff, customer, public; `read`): a tool asks which of some
  records the caller holds access to, and is told. Opened to customers and the public because
  a course page and `myCourses` must say "open" or "buy" without working it out.
- **A tool's own operation calls start automations**, as the same write from the admin does (the
  runner gives them its events queue), and **a tool or an automation may call another
  extension's tool** (`x.programs.assign`), run by the runner's own extension host under that
  extension's permissions; an automation's call has no `ctx.caller`, as an automation has none.
  Before this, a customer's progress row written by a tool started nothing.
- **`programs.session` shows its student which program it is** (`program` in its customer read),
  so a session lesson finds the student's own session.
- **The block lint's `noPurchase`**: a block marked so in its `block.json` may list no order or
  buy operation, and its code may name no price, `useBuy`, checkout or `formatPrice`
  (`scripts/check-blocks.mjs`). "No buying in the app" is held by the lint, not by memory.

### Session lessons (step 6)
On a student's first progress row of a course (written only with access), the automation
`assignSessions` assigns each program the course's session lessons use, from that day, with
Programs' own `assign` (one dated session per session of its layout; the dates a suggested pace),
unless it is assigned to them already. `startSession` then gives the student's own session, or
`preparing` until the assignment exists; they log sets with Programs' `logAdd`. Someone without
access writes no progress, so is assigned nothing and has no session to log on.

### The assistant's draft
`draft` builds a working copy from a brief out of ready videos in the library (matched to the
brief's words) and published programs, and never publishes. A publish asked for by the assistant or
an MCP client waits for a person (ADR 0480).

## Proof
- `packs/courses/test/courses.test.ts` (the SDK's test host): the contract and `requires`; every
  kind of lesson, a broken one refused with its path, a bad key refused; the outline without
  access keeps titles and previews only; completion, the last ten seconds, the programs, a key
  used twice; every tool and the automation.
- `apps/runner/test/courses.test.ts` (the real host, the payments fake, the fake Stream): Courses
  refused before Programs and installed after it; buying grants one enrolment in the paid batch,
  the buyer reads the lesson and plays its video with what `lesson` named, a stranger and the
  public cannot, buying again is refused, the stranger reads none of the buyer's enrolments; a
  full refund approved by a person voids the enrolment and ends the lesson, the playback and the
  progress; an enrolment past its `until` gives nothing; staff's enrolment ends with
  `endEnrolment`, and staff cannot void one; a bundle reaches its courses and no other, and a
  course added to it reaches the buyer once published; progress is kept, resumed, done near the
  end, completes the course and survives a new version keeping the keys; the first progress
  assigns the session program from today, `startSession` finds it, and a set is logged with
  Programs' tool; someone without access is assigned nothing; a draft over MCP, its publish
  queued; the hooks a customer's client gets, and when playback asks again.
- `scripts/check-blocks.test.mjs`: a `noPurchase` block that buys fails; every native courses
  block is `noPurchase`.
- `apps/app/e2e/courses.spec.ts`: staff build and publish a course with a (fake) video in the
  builder block; a student signs in, buys on the course page block with the fake provider, plays
  the lesson in the player block, and their progress is kept; someone else cannot play it.

Each check removed, tests fail (restored after; counts of the runner, pack and lint tests):

| Check removed | Tests that failed |
| --- | --- |
| Progress needs access (`requireAccess` in the seam's write helpers) | runner 2 |
| Buying a course already held is refused (`buy`) | pack 1; the runner file did not start |
| A lesson is not found without access unless a free preview (`lesson`) | runner 3, pack 1 |
| `access.check` answers the host's question (it answered every id held) | runner 3 |
| An extension's `requires` is checked at install | the runner file failed at setup (Courses installed before Programs) |
| Only the host voids an enrolment (staff allowed too) | runner 1 |
| A void enrolment gives no access (no `states` on the sources) | pack 1 (the manifest check); the runner file failed at setup |
| A `noPurchase` block may not buy (the lint rule off) | lint 1 |

The runner's file is `apps/runner/test/courses.test.ts` (7 tests), the pack's
`packs/courses/test/courses.test.ts` (15), the lint's `scripts/check-blocks.test.mjs` (6). "Failed
at setup" is its `beforeAll` failing, so every test of the file failed to run.

## Consequences
- `@composable-os/pack-courses` is a new npm package: it must be published once by hand before
  the first release that carries it (`docs/deploying.md`, "Publishing to npm"), or that release's
  `npm` job fails on it.
- A product that lists Courses must list Programs.
- A lesson key used in two sections is not refused by the host (the schema refuses one twice
  within a section): the builder's edits always make a fresh key, and `outlineProblems` lists
  any for the import (step 8) to refuse.
