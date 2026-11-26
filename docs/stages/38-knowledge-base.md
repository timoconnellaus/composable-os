# Stage 38: Knowledge base

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Behaviours, Packs and blocks), [`CONTEXT.md`](../../CONTEXT.md) (Publish, Version, Working copy,
Media, Preview, Pack role, Grant, Checklist), stages [28](28-content.md) (Content),
[42](42-courses.md) (Courses, for training), [44](44-agreements.md) (Agreements, for what it is and
is not), [45](45-rostering.md) (warnings, step 4b's checklists) and [47](47-pack-screens.md) (pack
screens); ADRs [0154](../adr/0154-embeddings-queue-and-vectorize.md),
[0155](../adr/0155-hybrid-search-similar-records-and-retrieval.md),
[0320](../adr/0320-erase-reaches-every-store.md),
[0436](../adr/0436-pack-roles-and-the-door-role.md),
[0440](../adr/0440-rich-text-is-data.md) to [0447](../adr/0447-the-signed-in-scope.md),
[0451](../adr/0451-role-clients-staff-in-the-mobile-app-and-browser-calls.md),
[0477](../adr/0477-the-access-scope.md), [0478](../adr/0478-the-courses-pack.md),
[0480](../adr/0480-an-ai-asks-to-publish-a-person-approves.md),
[0488](../adr/0488-the-subscription-access-source.md),
[0600](../adr/0600-a-pack-role-and-its-grants-add-up.md),
[0622](../adr/0622-warnings-in-a-writes-answer.md) and
[0650](../adr/0650-checklists-templates-runs-ticks-and-a-done-run-kept-unchanged.md).

Status: **spec agreed** (owner interviewed 2026-11-24: decisions 1 to 11; decisions 12 to 17
decided by the coordinator the same day under the owner's standing rule that best-practice answers
are decided, not asked). Roadmap stage 38, issue
[#106](https://github.com/timoconnellaus/composable-os/issues/106). Every step may start in the
order below; nothing waits for an interview.

## Goal

A business writes down how it does things and answers its customers' common questions, once, in
one place. Staff procedures ("how we open up", "what we do when someone is hurt") are read by staff
on the web and in the app, always in their latest published wording. When a procedure is published,
or changed in a way that matters, the people who must know it are asked to confirm "I have read and
understood this" with one tap, and the owner sees who has and who has not. Someone not yet
confirmed shows a warning on the roster, never a block. For the more complicated things, a
procedure can instead require a short course to be completed, built in Courses with staff as the
learners. Help pages ("how do I pause my membership", "where do I park") sit on the business's own
website for anyone, with a search box, and in the members' app. The assistant answers staff
questions from the published procedures, always linking the procedure it used, and says plainly
when nothing covers the question. Drafts are never read by anyone but staff editing them, and
nothing an AI writes reaches staff or customers until a person publishes it.

The platform ships no procedures and no help pages. They are the business's content, added once it
is running, in the admin or through the assistant or an MCP client, with a person approving each
publish. This spec decides how the feature behaves, not what any business writes.

## Who it is for

**Gyms and studios first.** Procedures: opening and closing, cleaning standards, an injury or
incident, a child left after class, a fire alarm, handling a complaint, the front desk's routine, a
new coach's first week. Read and understood matters most for the safety ones, and a course (first
aid steps, a new piece of equipment) for the few that need more than reading. Help pages: booking
and cancelling, late-cancel rules in plain words, pausing or ending a membership, kids' classes,
parking, what to bring, how the app works. Most readers are on a phone.

**Trades and services next.** The same two halves, with differences:

- **Procedures are read on site**, often with poor signal: reading the latest published copy
  offline in the app matters more (out of scope here, named under risks).
- **Procedures belong to kinds of work** (an install, working at height, a site induction) more
  than to shifts. That is a link to a job type, which waits for stage 39 (Jobs).
- **Subcontractors** need to confirm procedures but are not staff accounts. Not in this stage:
  they are outside people, closer to stage 43's practitioners or to Agreements.
- **Help pages are care and after-sales guides**: looking after what was installed, what the
  warranty covers in the business's own words, preparing for a visit. A help page linked from a
  quote or a job's email is the common way in.

## What exists today (from the code, checked 2026-11-24)

- **`publishable`** (ADRs 0441, 0446): a working copy staff edit, published versions kept in
  `core_publish_version`, states draft / scheduled / published / unpublished, `record.publish`
  for a person with `records:publish` (admins by default, grantable: `packages/core/src/principals.ts`),
  an AI may only ask (ADR 0480), versions, compare and restore.
  `packages/core/src/records/publish.ts`, `packages/core/src/operations/record-versions.ts`,
  `packages/sdk/src/contract.ts`, `packages/sdk/src/manifest.ts`.
- **Public reads of content** (ADR 0442): `content.get` and `content.list` in
  `packages/core/src/operations/content.ts` read the published version through the public scope,
  for an object that declares `public`, with one not-found answer, cached
  (`packages/core/src/content/cache.ts`), and preview links. `content.list` filters on fields; it
  has **no text search**. A `public` declaration may carry a `when` (a field's value, or one through
  a relation: `packages/core/src/visibility/public.ts`), so an object *can* be public for some
  records only.
- **Rich text is data** (ADR 0440, `packages/sdk/src/rich-text.ts`): paragraph, heading, list,
  quote, image, divider, embed, callout, button. Headings carry no id.
- **Media** (ADR 0444, `packages/core/src/operations/media.ts`): `media.serve` gives staff any live
  item and an outsider only one a published record they may read shows (`core_published_media`).
  So a picture in a staff-only procedure is never served to the public. `media.play`
  (`operations/media-video.ts`) plays any video to staff, and to a customer only a holder's.
- **The Content pack** (`packs/content`): posts and categories, web and native rich-text renderers
  (`packs/content/blocks/content-rich-text`, `content-native-rich-text`), `cos content import`
  (`packages/create-composable-os/src/content-import/`, posts only).
- **The signed-in scope** (ADR 0447): `public` and `signedIn` are exclusive on one object.
- **Search**: `search.global` (FTS5 over core objects, `operations/search.ts`) and `search.hybrid`
  (FTS plus vectors, `operations/summary.ts` over `ai/hybrid.ts`, ADR 0155) over records' **working
  copies**, one vector per record of at most 2,000 characters (`EMBED_TEXT_CHARS`,
  `ai/embedding.ts`). Nothing indexes published versions or passages within a long document.
- **Roles and pack roles**: staff roles are admin, member and viewer (`principals.ts`). Pack roles
  (ADR 0436, `packages/core/src/pack-roles.ts`): Bookings' `coach`, Rostering's `team` (a
  cleaner), Ticketing's `door`. A pack-role account may call only its pack's tools and
  `record.get` and `record.list` on its pack's objects (`PACK_ROLE_READS`, `packRoleReaches`);
  a grant opens a pack tool, never a core operation (ADR 0600). "Front desk" is not a role: it is
  the grant `bookings:desk`. Such an account could not read a Knowledge pack's procedures today.
- **Roster warnings** (stage 45, ADR 0622, `packages/core/src/staffing/`): `unavailable`,
  `not_qualified`, `uncovered`, returned with a write and by `staffing.check`, never refusing; an
  assistant gets no `unavailable` warning.
- **Checklists** (stage 45 step 4b, ADR 0650, `packages/core/src/checklists/`,
  `operations/checklist.ts`, migration 0815's `core_checklist`): templates and steps, a run per
  shift ticked by its person, a done run kept unchanged. A checklist says *what* to tick; it has no
  place for *how* or *why*.
- **Agreements** (stage 44, `packages/core/src/agreements/`): documents a **Person** accepts, with
  "small change" or "agree again". Its spec puts agreements for staff themselves out of scope.
- **Courses** (stage 42, `packs/courses`, ADRs 0477, 0478, 0488): a course's outline of lessons, an
  enrolment and progress per lesson. **Every learner is a Person**: `courses.enrolment.holder` and
  `courses.progress.holder` are relations to `person`, and a customer reads and writes them through
  the `customer` scope (`my.*`). Access comes from an enrolment (bought, given by staff with
  `x.courses.enrol` and no order, or imported) or a course subscription that covers every live
  course. `progress`, `myCourses` and `startSession` are customer-only tools; `lesson` lets any
  staff caller read every published lesson. A course's `price` is required and every course is
  public. Staff accounts (`core_user`) are not Persons, so a staff member cannot be a learner today.
- **Pack screens** (stage 47, spec agreed, being built in PR #303): a shipped pack declares its
  staff screens; the admin shows each person only the ones they may open; fixed-role accounts get
  a small shell. Its `packRoleReaches` change opens only `screens.mine`.
- **Notifications to staff**: `notification.send`, in-app and by email as each person prefers.

## Decided at the interview (2026-11-24)

| # | Decision |
| --- | --- |
| 1 | **The procedures are the business's content, added once it is running**: in the admin, or by the assistant or an MCP client with a person approving the publish. The spec decides behaviour, not content. (Today staff learn from shared documents and spreadsheets.) |
| 2 | **Who must confirm is chosen per procedure**: everyone, or some roles (such as coaches, the front desk or cleaners) |
| 3 | **Confirming is one tap** on "I have read and understood this" |
| 4 | **Not confirmed is a warning on the roster**: the person can still be put on and work the shift. Never a block |
| 5 | **Help pages are for anyone on the website**, signed in or not |
| 6 | **No AI answer box on the public help pages for now**: a search box that finds the right page |
| 7 | **The assistant answers staff from published procedures**, always linking the procedure it used, and saying plainly when no procedure covers the question |
| 8 | **Any staff member writes; the owner, or someone they allow, publishes** |
| 9 | **The publisher chooses each time a procedure changes**: a small fix keeps earlier confirmations; an important change asks everyone again |
| 10 | **A review reminder per procedure, default 12 months** (0 means never) |
| 11 | **Training** (raised by the owner in the interview's chat): for more complicated things, a procedure can require completing a course rather than only reading and confirming, using the Courses pack's lessons and progress with staff as the learners and no payment. "Training not completed" raises the same roster warning as "not yet confirmed" |

### Decided by the coordinator (2026-11-24)

The questions the interview left open or decision 11 raised, each decided at the spec's
recommendation under the owner's standing rule (best-practice answers are decided, not asked). The
owner may override any of them.

| # | Decision | Why |
| --- | --- | --- |
| 12 | **Training expiry is chosen per procedure**: "redo every N months", empty for never. When it lapses the procedure is to read again, with the roster warning | Some training (first aid steps) is meant to be refreshed and most is not; it mirrors the review reminder per procedure |
| 13 | **A rosterer sees the warning naming the person and the procedure** ("Sam has not read: Injuries"); the full read status is only for `knowledge:manage` | Enough to act on before the shift; the whole picture stays with the owner and those they allow |
| 14 | **An important change to a procedure with training asks for a tap on the new wording**, not the course again; redoing the course comes from expiry (decision 12) | Redoing a whole course for a changed step would be ignored or resented |
| 15 | **A training course has no Programs sessions** for now: videos, text and downloads | Programs sessions belong to a Person; Programs for staff is its own change |
| 16 | **A course is for customers or for staff, never both** | Keeps staff training out of the shop and the course subscription |
| 17 | **Every procedure a person must read and has not warns on the roster** | Simple first; a per-procedure "needed before a shift" switch can follow if the warnings get noisy |

## The design in one page

**A Knowledge pack (`packs/knowledge`) with two publishable objects.** A **procedure** is for staff
only: it declares no `public` and no `signedIn`, so "never public" is a property of the object. A
**help page** declares `public`, so it is read on the website through `content.get` and
`content.list` exactly as a blog post is. Each has its own grouping object (procedures' sections
are staff only; help topics are public). Both are written in the admin's rich-text editor, drafted
by staff or the assistant, and published by a person.

**Staff read what was published, not the draft.** A new declaration on `publishable`, **staff
read**, opens the published version to every staff account through two host operations, including
accounts with a pack role (a cleaner, a coach), which today read nothing outside their own pack.
The admin's record page still shows the working copy to editors.

**Read and understood is a small addition to `publishable`, not Agreements.** An object declares
**acknowledge**. Who must read is chosen per procedure. When a person publishes, they say whether
this version asks everyone again (**read again**) or is a **small fix**; the first version always
asks. Each person who must read it confirms the current version with one tap; the host keeps a row
nobody changes (who, which version, when). The owner and those they allow see, for each procedure,
who has confirmed the current wording, who has not, and since when.

**The roster warns.** A person with a procedure still to read gets a fourth roster warning,
`to_read`, beside `unavailable`, `not_qualified` and `uncovered`: shown when they are put on a
shift and on the roster, never refusing (decision 4, ADR 0622's rule).

**Search over published words.** The host keeps a text index of each record's **published**
version, written in the publish batch and cleared on unpublish, erase and purge. `content.search`
answers the public (help pages) and staff (procedures too) with titles, the section heading and a
highlighted snippet, never a draft.

**The assistant answers with sources.** Published versions are split into **passages** at their
headings and embedded. A staff operation returns the passages that best match a question, each with
its record, version and section. The assistant gets it as a tool with a short skill: answer only
from what it returned, cite every passage used as a link to its section, say which version, and say
"no procedure covers this" when nothing matches.

**Checklists point at procedures.** A checklist template may name one procedure as its "how to";
the person ticking a shift's checklist opens it from there.

**Training, a named later step (step 10).** A procedure may require a course instead of a tap. The
course is a Courses course marked **for staff**: not public, not sold, not in any subscription. Its
learners are staff accounts, who open it from their "to read" list, on the web and in the app. The
procedure counts as done for a person when the host says they completed the course. Until then it
is to read, with the same roster warning. This needs platform work (staff as learners, an access
source for staff, a reach for pack roles, completion as a host answer) and changes to Courses,
listed below. Steps 1 to 9 build the read-and-confirm part without any of it.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **Use Agreements (stage 44) for "read and understood"** | Agreements records what a *Person* (a customer) agreed to, as evidence for payment disputes and waivers: acceptances are keyed to a Person, checked at checkout and booking, with signatures, health answers, a copy by email and a signed PDF; its documents allow no pictures; an AI may not even ask to publish one. Procedures are read by staff accounts, change often, need pictures, are searched and cited by the assistant, and are confirmed with a tap. Its ideas are reused: rows nobody changes, a version per wording, "agree again" versus "small change". An employment contract a staff member signs stays a candidate for Agreements later |
| **Procedures as Content posts with a category** | A post could be hidden from the public with `public.when` on its category, but then "staff only" would be a value a writer (or an AI drafting) can change, and one wrong edit publishes an injury procedure to the website. Two objects keep "never public" a property of the object that no edit can change |
| **Procedures inside the Rostering pack** | Procedures are read by people who are never rostered and later attached to things other than shifts (a job type). The link to shifts goes through core: warnings and checklists |
| **Procedures as core tables, like checklists** | Procedures hold nothing personal, and `publishable` already gives versions, scheduling, publish requests, media and the editor. Only the confirmations are personal, and they are core rows |
| **Hiding some procedures from some staff** | Every staff role reads every record today; per-record visibility for staff is stage 14a. "Must read" decides who is asked to confirm, not who may read |
| **Blocking the shift until confirmed** | The owner chose a warning (decision 4): a block could leave a class with no coach on the day |
| **Help pages for signed-in members only** | The owner chose anyone (decision 5). The signed-in scope reads the working copy; serving published versions there is platform work of its own, later if asked |
| **One vector per record for the assistant** | A procedure is longer than 2,000 characters and a citation must point at a section. Passages at headings give both |
| **The assistant answering from drafts or its own knowledge** | Staff would act on unpublished or invented instructions (decision 7) |
| **Proof that someone read the text** (time on page, scrolling) | It proves nothing and feels like surveillance. A confirmation is a person's own statement, kept with its version |
| **Training as quizzes inside Knowledge** | Courses already has lessons, video, progress and two skins. A second course engine is duplication; staff as Courses learners is the platform's gap to close |
| **A Person record for every staff member, so Courses works unchanged** | It mixes staff into the customer list (search, duplicates, erase, customer sign-in by the same email) and makes a staff account's training a customer's record. A staff learner is a staff account |

## Platform work and pack work

| Piece | Platform or pack | Why |
| --- | --- | --- |
| **Staff read of published versions** (`publishable.staffRead`), `content.staffGet` and `content.staffList`, open to every staff account including pack roles | **Platform** (SDK, manifest checks, `operations/content.ts`, `pack-roles.ts`) | Who may read is the host's; a pack role's limits are core |
| **Acknowledgements**: the `acknowledge` declaration, "read again" on `record.publish` and the publish request card, `core_publish_ack` (insert only), who must read, what is due, the status per record | **Platform** (SDK, `records/publish.ts`, `record-versions.ts`, a migration) | A rule for every actor: only the person confirms for themselves, never an AI, and nothing changes once written |
| **The `to_read` roster warning** | **Platform** (`staffing/`, amends ADR 0622) | Warnings are the host's, the same answer whoever writes |
| **Published-text index and `content.search`** (public and staff) | **Platform** (a migration, `records/publish.ts`, `operations/content.ts`) | Built once for every publishable object: posts gain search too |
| **Section anchors**: one per heading, made by the host from the heading's text and position | **Platform** (`sdk/rich-text.ts` helper, both renderers) | Citations and search results link to a section; no schema change |
| **Passages and `content.passages`** for staff; the assistant's tool and skill | **Platform** (`ai/embedding.ts`, `ai/hybrid.ts`, `assistant/skills.ts`) | The embedding queue and the assistant are core |
| **A checklist's "how to"** | **Platform** (`checklists/`, a migration, the checklist blocks) | Checklists are core (ADR 0650) |
| **Staff as learners, the training access source, the learners' reach for pack roles, completion as a host answer** (step 10) | **Platform** | Who may read a course and whose progress a row is are the host's rules (ADRs 0477, 0478, 0436) |
| **A course for staff, a learner on progress, staff audiences on the learning tools, the learners' screens** (step 10) | **Pack** (`packs/courses`) | Composition of the above |
| Notices: confirm a new version, reminders, a review date reached | **Pack** words, **host** sends (`notification.send`, date-relative triggers) | Existing paths |
| `knowledge.procedure`, `knowledge.section`, `knowledge.helpPage`, `knowledge.helpTopic`, views, settings, tools, hooks | **Pack** (`packs/knowledge`) | Composition of the above |
| Blocks: help centre (list, topic, page, search), web and native; procedures reader, "to read" list and confirm, web and native; read status (web); declared staff screens | **Pack** blocks, **admin** screens (stage 47) | Web and native share hooks, not screens |
| An AI answer box on the public help pages | Not now (decision 6) | A public AI call is new: cost, abuse, what it may say |

## The model

### Words

A **procedure** is how the business does something, for staff. A **help page** answers a
customer's question on the business's website. A **section** groups procedures; a **help topic**
groups help pages. A **confirmation** (read and understood) is one staff account saying they have
read and understood one published version of a procedure. A version is **read again** when its
publisher said everyone must confirm it again; otherwise it is a **small fix** and earlier
confirmations still count. A procedure is **to read** for a person when they must read it and have
nothing that counts: no confirmation that counts or, for a procedure with **training**, no
completion of its course. A **passage** is one section of a published version, as the assistant and
search see it. A **learner** is a staff account taking a course for staff (step 10).

### Records (`packs/knowledge`)

| Object | Fields | Behaviours |
| --- | --- | --- |
| `knowledge.procedure` | title, slug, summary, body (`richText`), section (relation), owner (user: who keeps it right), must read (`everyone`, or a list of: staff roles admin, member and viewer; the installed pack roles; grantable pack permissions such as `bookings:desk` for the front desk), review every (months, default 12, 0 for never), next review (date, from the last publish), training course and redo training every (months, empty for never) (step 10, empty until then) | `publishable { content: [title, summary, body, section], slug, staffRead: true, acknowledge: { who: "mustRead" } }`. No `public`, no `signedIn` |
| `knowledge.section` | name, order | none; staff only |
| `knowledge.helpPage` | title, slug, summary, body (`richText`), topic (relation), order, related pages (relations), search title, search description, hide from search engines | `publishable { content: [...], slug }`, `public.read` of the content fields and slug |
| `knowledge.helpTopic` | name, slug, order, icon (a fixed list) | `public.read: [name, slug, order, icon]` |

"Must read" and "review every" are outside the published content: changing who must read takes
effect at once (acceptance criterion 6), and is a person's write (below).

**`core_publish_ack`** (platform): object, record, version, account (staff user id), confirmed at,
how (`self`; no other way). Insert only: a trigger refuses update and delete for everyone, and an
insert for a version that is not the record's current one. Erase handling below.

**Who must read** is checked by the host against the account's role, pack role and grants on the
day: an account that joins later has the procedure to read; a deactivated account has nothing to
read and keeps its confirmations.

**Which confirmation counts**: the latest confirmation of a version at or after the procedure's
latest read-again version. A small fix leaves that version unchanged, so earlier confirmations
count.

### States

`publishable`'s four: draft, scheduled, published, unpublished. Unpublishing a procedure removes
it from staff reading, from everyone's "to read" and from the roster's warnings, and keeps its
versions and confirmations. A scheduled read-again version asks nobody until it goes live.

### Operations

| Operation | Audience | Who may | Risk | What |
| --- | --- | --- | --- | --- |
| `content.staffGet { object, slug \| id }` | staff | every staff account, pack roles included, for objects declaring `staffRead` | read | The current published version; not found for a draft or unpublished record |
| `content.staffList { object, filter?, cursor? }` | staff | as above | read | Published versions only, each with its version number and date |
| `content.search { object, q, cursor? }` | public, customer, staff | the public for `public` objects; staff also for `staffRead` objects | read | Matches in published words: title, section heading, anchor, a highlighted snippet as segments (no HTML). Rate limited for the public. Every query word a prefix match, as `search.global` |
| `content.passages { q, objects?, limit? }` | staff | staff accounts without a pack role (the assistant's users) | read | The best passages from published `staffRead` and `public` objects: record, version, heading, anchor, text. Never a working copy |
| `record.publish { ..., readAgain? }` | staff | a person with `records:publish` (unchanged; an AI asks, ADR 0480) | write | On an `acknowledge` object, `readAgain` is true for the first version and must be stated for later ones; an AI's publish request carries its suggestion and the approver chooses |
| `ack.confirm { object, id, version }` | staff | the account itself, `actors: ["human"]`, pack roles included | write | Records a confirmation of the current version. Refused for a version that is not current, an account not in "must read", and twice for one version. On a procedure with training, refused until the account has a completion of its course that holds (completing the course counts for the version current then; a later read-again version asks for a tap, decision 14) |
| `ack.mine {}` | staff | the account itself, pack roles included | read | What is to read for me (and, step 10, which needs a course), and what I confirmed and when |
| `ack.status { object, id }` | staff | `knowledge:manage` (admins, grantable, restricted, a person only) | read | For the current version: who must read, who confirmed or completed and when, who has not and since when |
| `ack.overview {}` | staff | `knowledge:manage` | read | Every acknowledged procedure: how many have confirmed the current version of how many |
| `staffing.check` and the roster writes (amended) | staff | unchanged | — | Return `to_read` for a person with anything to read, naming the procedures (decision 13). Not returned to an AI actor, as `unavailable` is not |
| `checklist.save` (amended) | staff | `checklists:write` (unchanged) | write | A template may name one published procedure as its "how to" |

`ack.*` and `content.passages` read core tables in no `rec_*` view, so dashboards, `query.sql`,
exports and the assistant's record reads do not reach confirmations.

**Who writes.** Procedures and help pages are written by staff with `records:write` (members and
admins), and by a pack-role account (a coach, a cleaner) given `knowledge:write`, grantable as
ADR 0600 allows. Publishing is `records:publish` (admins, and those an admin grants it to,
decision 8). Changing "must read" or "review every" on a published procedure is `knowledge:manage`.

### Tools (the pack's)

`knowledge.toRead` (my list), `knowledge.confirm` (`humanOnly`), `knowledge.readStatus`
(`knowledge:manage`), `knowledge.helpTopics` (public: the topics for a site's menu),
`knowledge.draftProcedure` and `knowledge.draftHelpPage` (staff and the assistant: write a working
copy from notes; a person reviews and publishes). Through these and `record.*`, the assistant or an
MCP client adds the business's procedures once it is running (decision 1).

### Screens

- **Web admin** (declared pack screens, stage 47): Procedures (published, by section, with search;
  each opens in the reader with "Version 4, published 3 March" and a Confirm button when it is to
  read); To read (mine); Read status (`knowledge:manage`: per procedure and per person; export as
  CSV); Help pages and the editor, which are the host's record pages with the rich-text editor and
  publish controls. "Read again or small fix" is a step of publishing an acknowledged procedure.
- **Customer web** (the business's site, through the typed client): a help centre: topics, a
  topic's pages, a page, a search box with results as you type, related pages. Web-skin blocks the
  business styles.
- **Native**: for members, the same help centre in the native skin. For staff (role clients, ADR
  0451), Procedures, the reader with Confirm, and To read. A cleaner or coach with a pack role sees
  these too.
- **Roster**: the `to_read` warning beside the person, as the other warnings are shown.
- **Checklist tick screen** (Rostering's "my shifts"): a "How to" link when the template names a
  procedure.

### Notifications

All to staff, through `notification.send`; nothing to customers.

| When | Who | What |
| --- | --- | --- |
| A read-again version goes live | everyone who must read it | "Please read: How we handle an injury (updated)" with a link |
| A procedure has been to read for 7 days | that person, once | a reminder |
| Weekly, while anything is outstanding | the procedure's owner | who has not confirmed what |
| A procedure's next review date arrives | its owner | "Time to check this is still right" |
| A new staff account is made | that person | their list of procedures to read |

### What an AI may do

- **May**: draft and edit working copies of procedures and help pages (an ordinary write through
  the gate); ask to publish, always queued for a person (ADR 0480), with "read again" or "small
  fix" as a suggestion the approver sees and decides; read published procedures and help pages;
  answer staff questions from `content.passages`, citing each passage used.
- **May not**: publish; confirm for anyone (`humanOnly`); read who has or has not confirmed or
  completed; see the `to_read` warning; edit "must read". The assistant does not answer from drafts,
  and says when no published procedure covers a question rather than answering from general
  knowledge.
- **Text in procedures is data, not instructions**: a passage that says "ignore your rules" is
  quoted, never obeyed. Passages reach the model inside a marked block, as synced email does.
- **A help page drafted from a customer conversation** must not carry the customer's details; the
  draft is reviewed by the person who publishes.

### Privacy and erase

- Procedures and help pages are the business's text, not personal data. A procedure may still name
  staff ("call Sam"); the editor's help says to name a role instead.
- Confirmations are staff records: read by the account itself and by `knowledge:manage`, and
  summarised to rosterers as the `to_read` warning. They are kept when an account is deactivated,
  as evidence the business may need. How long to keep them is for the business to confirm with its
  accountant or lawyer; this stage keeps them for good and removes them with the account's erase,
  through ADR 0320's erase of every store.
- Purging a procedure deletes its versions, index rows, passages, vectors and confirmations.
- Public search keeps no query text with who asked; rate limiting uses the host's existing binding.
- Pictures in a procedure are served to staff only (the existing `media.serve` rule).

## Training through Courses (step 10, platform and pack)

What a course for staff needs, from what Courses is today (above). The interview settled that
training is wanted; decisions 12 to 16 settle its details.

### The learner record

- **A learner is a staff account, not a Person.** `courses.progress` gains `learner` (a `user`
  field); `holder` stops being required. Each row has exactly one of the two, set by the host from
  the caller (a customer's `my.create` sets `holder`; a staff learner's write sets `learner`), never
  from the input.
- **No enrolment for staff.** A staff learner's access comes from the training source (below), not
  from an enrolment, so nothing is bought, given or voided, and Courses' enrolment, `sellable`,
  refund and agreement paths are untouched.

### Access without an order: the `training` source

- The access seam (ADR 0477) today answers "does this customer hold access to this record". It
  gains staff callers and a source kind, `training`: **a staff account holds access to a course
  when a published procedure that requires that course has the account in "must read"**. Declared
  by Courses as `{ kind: "training" }` among `courses.course`'s sources; the seam's one function
  and `media.play`'s use of it do not change shape (the subscription source was added the same way,
  ADR 0488).
- Staff with a full role already read every published lesson (`lesson`'s staff branch) and play
  every video (`media.play`); the source matters for what they may **write** (their own progress)
  and for pack-role accounts, which reach nothing of Courses today.

### Progress for a staff account

- **A staff twin of the `customer` scope** (platform): an object may declare `staffOwn: { field,
  read, write, requireAccess }` (the name is the build's), and staff reach their own rows of it
  through the host's own-row operations (the `my.*` operations opened to the staff audience for
  such objects, or a staff counterpart). The host fills the owner field from the caller, refuses
  another account's rows, and honours `requireAccess` against the training source. Today staff
  write records only through `record.*` with `records:write`, which a viewer or a pack-role
  account does not have, and which would let one staff member write another's progress.
- `courses.progress` declares it on `learner`, with `requireAccess: ["course"]` as its `customer`
  declaration has.

### Completion as the host's answer

- The roster warning and "to read" are the host's, so **whether an account completed a course is
  the host's answer**, from the published outline and the progress rows, by the rule Courses uses
  today (every lesson that is not a download is done). Courses declares where its outline and
  progress are (a `training` declaration on `courses.course`); the host's one function answers
  "has this account completed this course", and nothing in a block or a tool decides it.
- What counts: a completion holds until the procedure's "redo training every" months pass since
  it (decision 12; empty for never), and then the procedure is to read again. A completion counts
  for the procedure's version current when it was made; after a later read-again version, the
  person confirms the new wording with a tap (decision 14).

### The course itself

- `courses.course` gains **for** (`customers`, the default, or `staff`). A course for staff:
  - is not public: `public` gains `when: { field: "for", in: ["customers"] }`, so it is not in the
    catalogue, not found by `course`, and its lessons are never read by a customer;
  - is not sold: `price` stops being required for it, and the host refuses an order for it
    (`sellable` gains a `when`, platform, or the pack's `buy` is refused as not found and the
    contract check proves no paid line can name it: the build's choice, in its ADR);
  - is in no subscription: the subscription source's `covers: "all"` (ADR 0488) gains a filter
    honouring `for` (platform), so a subscriber never reaches staff training;
  - has no `session` lessons in the first build: a Programs session belongs to a Person, so a
    course for staff with a session lesson is refused at publish (decision 15).
- Writing and publishing a course for staff is as any course: the course builder, a person
  publishes.

### The staff's surfaces

- Courses' tools `lesson`, `progress` and a new `myTraining` (the staff twin of `myCourses`: the
  courses my procedures require, with how far I am) take the `staff` audience for the caller's own
  learning. `startSession` stays customer-only.
- **Pack-role accounts** (a coach, a cleaner, the door): a tool a pack marks for learners reaches
  every staff account, and `media.play` reaches a pack-role account for a course the training
  source gives it (platform, `pack-roles.ts`, amending ADRs 0436 and 0600). Nothing else of
  Courses opens to them. Tested against every pack role.
- **Web**: Courses declares a "My training" screen and the player as staff screens (stage 47),
  gated by `myTraining`. The existing Player and My courses blocks are reused through their hooks
  over the staff client (ADR 0453). Knowledge's To read list links a training procedure to its
  course.
- **Native**: the same screens in the staff role client (ADR 0451), from the existing native
  Player block (already `noPurchase`).

### What is not changed

Customers' enrolments, access, progress, the catalogue, selling, refunds, tax, agreements on
buying a course, the import, and the course subscription, except the `for` filter.

## Out of scope

- Hiding a procedure from some staff (stage 14a's visibility).
- Members-only help pages (the signed-in scope serving published versions).
- Reading procedures offline in the app.
- An AI answer box on the public help pages (decision 6).
- Procedures linked to job types (stage 39) or to class types.
- Confirmations by people who are not staff accounts (subcontractors, outside practitioners).
- Blocking a shift for someone who has not confirmed (decision 4).
- Quizzes and scores in training; session lessons in a course for staff.
- More than one language; comments on procedures; video hosting beyond embeds and Courses' video.
- Importing an existing help centre (`cos content import` is posts only; extending it is a small
  follow-on once a client has one to move).
- A support inbox or "was this helpful" feedback (stage 36, stage 29).

## Acceptance criteria

1. **Never public:** `content.get`, `content.list`, `content.search` and `media.serve` give the
   public and customers the one not-found answer for every procedure, its section and its pictures,
   published or not.
2. **Staff read what was published:** editing a published procedure's working copy changes nothing
   `content.staffGet`, `content.staffList`, `content.search` or `content.passages` return until a
   person publishes again.
3. **Pack roles read:** an account with only `rostering.team`, `bookings.coach` or `ticketing.door`
   reads published procedures and its own "to read" list and confirms, and is refused everything
   else as before.
4. **Confirm the current version only:** a confirmation of a superseded version, for another
   account, by an AI actor (assistant, MCP, automation, extension), or a second one for the same
   version, is refused; a confirmation row cannot be changed or deleted, by anyone, host code
   included.
5. **Read again and small fix:** after a read-again version goes live, everyone who must read it
   has it to read; after a small fix, earlier confirmations still count; the first version always
   asks. An AI's publish request shows its suggestion, and the approver chooses.
6. **Who must read:** choosing everyone or some roles, pack roles or grants per procedure; changing
   it, a person's role, pack role or grants, or deactivating an account changes who has it to read,
   from that moment, with no confirmation lost.
7. **Read status:** `ack.status` lists exactly who must read, who confirmed the current version and
   when, and who has not; it is refused to staff without `knowledge:manage` and to every AI.
8. **The roster warns, never blocks:** putting a person with a procedure to read on a shift
   succeeds with the `to_read` warning, in the write's answer and `staffing.check`; confirming
   clears it; an unpublished procedure raises none; an AI actor's answer carries none.
9. **Search:** a help page is found by a word in its body, as a prefix, only once published; an
   unpublished or purged page is not found; results carry the section anchor and no HTML.
10. **Passages and sources:** over the assistant, a question answered by a procedure is answered
    with a link to that procedure's section and its version; a question no procedure covers is
    answered "not covered", not from general knowledge; a draft's words are never in an answer
    (fixture test with a draft holding a unique word).
11. **Review reminder:** a procedure's review period defaults to 12 months; 0 sends none; the
    reminder reaches its owner on the date.
12. **Notices:** a read-again publish notifies exactly the people who must read it; the 7-day
    reminder is sent once.
13. **Checklist "how to":** a template naming a procedure shows its link on the tick screen; a
    template cannot name a draft-only procedure.
14. **Two skins:** the help centre and the procedure reader render the same fixtures through the web
    and native blocks, every rich-text block type and anchors included.
15. **Training (step 10):** a procedure requiring a course for staff is to read for each account in
    "must read" until the host says that account completed the course, with the same roster
    warning; `ack.confirm` is refused for it until the course is completed; a completion past the
    procedure's "redo training every" makes it to read again; after a read-again version a tap on
    the new wording counts, without redoing the course; a cleaner (pack role) opens the course, plays its
    videos and marks lessons done on the web and in the app and nothing else of Courses; a customer
    and a course subscriber never find, buy or read a course for staff; one staff account cannot
    write another's progress.
16. `cos ext check packs/knowledge` and `cos ext test packs/knowledge` pass (and `packs/courses` in
    step 10); `pnpm lint typecheck test` and the e2e journeys (a manager publishes a read-again
    procedure and a cleaner confirms it in the admin; a visitor searches the help centre and opens
    a page; in step 10, a cleaner completes a training course and the roster warning goes) pass in
    CI. ADRs, `CONTEXT.md` (Procedure, Help page, Confirmation, Read again, Passage, Learner) and
    `docs/architecture.md` are updated, and the site and `apps/marketing/SITE.md` when the pack is
    built, if they list packs.

## Dependencies

- **Built:** stage 28 (Content, `publishable`, media, editor, renderers), stages 22 and 23
  (audiences, typed client), stage 7 (embeddings, hybrid search), stage 45 (warnings, step 4b's
  checklists), stage 42 (Courses), ADRs 0436 and 0600 (pack roles and grants).
- **Being built:** stage 47 (pack screens, PR #303) for the admin screens; the pack and its native
  screens can be built before it, and the web screens are declared once it merges.
- **Agreed, being built in waves:** stage 17 (the one assistant) for where the assistant's tool and
  skill live (`packages/core/src/assistant/skills.ts`; `apps/app/src/server/assistant/` is stage
  17's reserved area).
- **Not specced:** stage 39 (Jobs) for procedures on job types; stage 14a for hiding procedures
  from some staff; stage 30 for push to the app.

## Migrations and numbers

Block **BE** in [`parallel-work.md`](../parallel-work.md): migrations 0970–0989, ADRs 0700–0709.
Expected migrations: the published-text index and passages (step 1); `core_publish_ack` with its
triggers (step 3); the checklist template's "how to" column on `core_checklist` (step 8); step
10's completion support if the host keeps any rows for it. New permissions: `knowledge:manage`
(restricted, a person only) and `knowledge:write` (grantable to pack roles), both the pack's. No
`x_*` table is touched by a migration.

ADRs the build writes:

1. The published-text index and `content.search` (**ADR 0700**); amends ADR 0442.
2. Staff read of published versions, and its reach for pack roles (**ADR 0701**); amends ADRs
   0436, 0446 and 0600.
3. Acknowledgements: who must read, read again and small fix, a confirmation nobody changes
   (**ADR 0702**); amends ADR 0480 (the request card shows the choice).
4. The `to_read` roster warning (**ADR 0703**); amends ADR 0622.
5. Passages and the assistant answering only from published sources (**ADR 0704**); amends ADRs
   0154 and 0155.
6. A checklist's "how to" (**ADR 0705**); amends ADR 0650.
7. The Knowledge pack (**ADR 0706**).
8. Staff as learners: the staff own-row scope, the `training` access source, the learners' reach,
   completion as a host answer, a course for staff (**ADR 0707**, step 10); amends ADRs 0477, 0478,
   0488, 0436 and 0600.

## Suggested build order

| Step | What | Touches | Beside |
| --- | --- | --- | --- |
| 1 | **Published-text index and `content.search`**, section anchors | `records/publish.ts` (index rows in the publish and unpublish batch), `operations/content.ts`, `sdk/rich-text.ts` (anchors), a migration, both content renderers | Any work not in `records/publish.ts`; Content's own follow-ups collide |
| 2 | **Staff read** (`staffRead`, `content.staffGet`, `content.staffList`) and its reach for pack roles | `sdk/contract.ts` and `manifest.ts`, `operations/content.ts`, **`pack-roles.ts`**, `pipeline.ts` | Collides with anything in `pack-roles.ts` or the pipeline's staff checks: **stage 47's build (PR #303) merges first**, and Rostering follow-ons. After step 1 or with it in one session |
| 3 | **Acknowledgements**: the declaration, `readAgain`, `core_publish_ack` and its triggers, `ack.*`, who must read (roles, pack roles, grants) | `sdk`, **`records/publish.ts`**, `operations/record-versions.ts`, the publish request card (ADR 0480), a migration | After step 1 (both in the publish batch); beside step 2 if the SDK edits are coordinated |
| 4 | **The `to_read` warning** | `staffing/` (the warnings), `operations/staffing.ts`, Rostering's roster blocks show it | After step 3; collides with any Rostering follow-on in `staffing/` |
| 5 | **The Knowledge pack**: objects, views, settings, tools, hooks, notices, the review reminder | `packs/knowledge` (new), the product's `packs` list | Starts on paper beside 1 to 4; merges after 2 and 3. Beside any other pack |
| 6 | **Blocks**: help centre (web, native), procedure reader, to read, confirm (web, native), read status (web); the declared screens | `packs/knowledge/blocks`, `client/` | After 5; the screen declarations after stage 47. Beside step 7 |
| 7 | **Passages and the assistant**: chunking at headings, passage vectors, `content.passages`, the tool and skill, citations in the chat | `ai/embedding.ts`, `ai/hybrid.ts`, `assistant/skills.ts` | After 1; beside 5 and 6; coordinate with stage 17's waves in flight |
| 8 | **Checklist "how to"** | `checklists/`, `operations/checklist.ts`, a migration (`core_checklist`), Rostering's checklist block | After 5; beside 6 and 7; collides with Rostering's checklist follow-ons |
| 9 | **The first client**: its procedures written (by staff or the assistant, published by a person), its help pages on its site | the client's repository | After 6 |
| 10 | **Training through Courses**: 10a platform (the staff own-row scope, the `training` source, the learners' reach, completion, the subscription's `for` filter); 10b `packs/courses` (`for`, `learner`, staff audiences, `myTraining`, screens) and Knowledge's training course field | 10a: `visibility/` (access), `pack-roles.ts`, `subscriptions/` (the source), `operations/media-video.ts`; 10b: `packs/courses`, `packs/knowledge` | After steps 3 and 4. 10a collides with any work in `visibility/` or `pack-roles.ts`; 10b with Courses' own follow-ons. Reviewed for security as step 2 is |

**Up to three sessions at once**: steps 1 then 3 in one (the publish batch); step 2 in a second
(after stage 47's merge), then 4; step 5 then 6 in a third, on paper first. Step 7 joins once step 1
is merged. Step 10 is its own session.

## Size

**Medium to large.** Five platform pieces for read and confirm (search index, staff read,
acknowledgements, the warning, passages), one new pack with a dozen blocks, then step 10 (four
platform pieces and a Courses change), the largest single step.

## Decided by this spec, open to override

| Choice | Decision |
| --- | --- |
| Agreements for "read and understood" | **No.** A small acknowledgement on `publishable`; Agreements stays for what customers agree to |
| Procedures and help pages | Two objects in one Knowledge pack, not Content posts with a category |
| Who reads procedures | Every staff account, pack roles included. "Must read" decides who is asked, not who may read |
| What "some roles" means | Staff roles, pack roles (coach, cleaner, door) and grantable pack permissions (the front desk's `bookings:desk`) |
| Who writes | Members and admins; a coach or cleaner when given `knowledge:write`. Viewers do not write |
| Who publishes | `records:publish`, as for every publishable object: someone allowed to publish procedures may also publish posts and courses. A per-object publish right is not built |
| The first version | Always asks everyone who must read it |
| Which procedures warn on the roster | Every procedure the person must read and has not (decision 17) |
| Reminders | After 7 days, once; a weekly summary to the procedure's owner |
| Keeping confirmations | For good, removed with an account's erase (for the business to confirm with its accountant or lawyer) |
| A training procedure | Completing the course takes the place of the first tap; a later read-again version asks for a tap (decision 14) |
| A course for staff | Not public, not sold, in no subscription, no session lessons, no enrolment |
| How a procedure names its course | An optional relation to `courses.course` that the contract allows only while Courses is installed (platform), so Knowledge does not require Courses; the build's ADR settles the mechanism |

## Questions for the owner

None open. The six questions this spec raised were decided by the coordinator (decisions 12 to
17), each at its recommendation; the owner may override any of them.

## Risks

- **Security:** steps 2 and 10 widen what a pack-role account may call; each reach must be exactly
  what this spec lists and be tested against every pack role. Step 10's staff own-row scope is a
  new door: one staff account must never read or write another's rows. Passages are untrusted text
  in the model's context.
- **Privacy:** confirmations show who has not done what; they are restricted to the person and
  `knowledge:manage`, summarised to rosterers only as the warning, and kept out of every bulk path.
- **Safety:** an out-of-date injury procedure is worse than none. The review reminder (12 months by
  default) and the owner's notices are the guard; the assistant always says which version and date
  it read.
- **Money:** none. Nothing here charges, prices or refunds; step 10 must prove a course for staff
  can never be bought or reached by a subscription.
- **Cost:** embedding passages costs a little per publish; video for training is Courses' existing
  cost.
- **Needs a real device or client:** the native reader, confirm and training player on phones; the
  help centre on a real client's site with its styling; whether real procedures fit "one procedure,
  sections by heading"; offline reading on a trades site (out of scope).
- **Evidence:** whether a tap, or a completed course, is enough evidence that a staff member was
  told a procedure, for insurance or workplace safety purposes, is for the business to confirm with
  its lawyer or accountant (and its insurer).

## Status

- **Step 1** — built — PR #340 — The published-text index and `content.search`. Migration 0970
  (`core_published_text` and its FTS5 table), ADR 0700 (amends ADR 0442). Section anchors in the
  SDK (`headingAnchors`, `richTextSections`), used by both content renderers; the index written in
  the publish and unpublish batch, remade by erase and caught up by the minute cron
  (`content.reindex`); `content.search` for the public, customers and staff over published words
  only. Left: passages for the assistant (step 7).

- **Step 2** — built — PR #418 — Staff read (branch `feat/stage-38-staff-read`). ADR 0701 (amends ADRs 0436,
  0446, 0600 and 0700); no migration. `publishable.staffRead` in the SDK and the registry; the
  seam's staff-read source over the live view (`visibility/staff-read.ts`: the content fields and
  slug, the version and when, never the working copy); `content.staffGet` (by id or slug, an old
  slug answers with its `redirect`) and `content.staffList`, staff only; `content.search` for a
  staff caller on a staff-read object over every text content field (the index holds them, a
  public search still matches only the public's). Every pack role reaches the three
  (`PACK_ROLE_STAFF_READS`), allowed only on a staff-read object, and the looks-after limit lets
  them through only for an object it does not name; `roles.json` lists them. Tested against a
  fixture role and the shipped `rostering.team`, `bookings.coach` and `ticketing.door`
  (`packages/core/test/staff-read.test.ts`). Left: a pack-role account is not served a
  procedure's pictures (`media.serve` is not in its reach; the spec lists no such reach, so it
  waits for a decision); the Knowledge pack declaring it (step 5).

- **Step 3** — built — PR #340 — Acknowledgements. Migration 0971 (`core_publish_ack` and its
  triggers, `read_again` on versions and schedules), ADR 0702 (amends ADRs 0480 and 0436).
  `publishable.acknowledge { who, manage }`, read again or small fix on every later publish (the
  approver chooses for an AI's request), `ack.confirm`, `ack.mine`, `ack.status`, `ack.overview`,
  who must read by staff role, pack role and grant on the day; every pack role reaches its own
  list and confirmations. Left: the `to_read` warning (step 4), the notices (step 5).

- **Step 4** — not built — needs: step 3 — The `to_read` warning on the roster

- **Step 5** — built — PR #457 — The Knowledge pack: objects, views, settings, tools, hooks,
  notices, the review reminder. ADR 0706 (amends ADR 0702); no migration. `packs/knowledge`:
  `knowledge.procedure` (staff-read, acknowledged, never public; review period guarded by
  `acknowledge.managed`, next review a formula over `publishedAt`), `knowledge.section`,
  `knowledge.helppage` (public as published) and `knowledge.helptopic`; tools `toRead`, `confirm`,
  `readStatus`, `helpTopics`, `draftProcedure`, `draftHelpPage`; the review reminder; client hooks.
  Platform: the host sends the declaration's notices (asked in the publish batch; reminder, weekly
  owner notice and welcome from `ack.due`); `ack.status`/`ack.overview` from the owning pack's
  person-only tool; formulas read `publishedAt`, date-relative triggers name a date formula. No
  settings (none named). Not added to a product's `packs` list: the CRM is this repository's
  only product and lists no gym pack; a client product lists it, and the release carries every
  pack. Left: blocks and screens (step 6); pack-role accounts are not served a procedure's
  pictures and cannot read section names.

- **Step 6** — built — PR #480 — Blocks: help centre, procedure reader, to read, confirm, read
  status; the declared screens. ADR 0708 (amends ADRs 0424 and 0660); no migration, no new
  operation. Web and native blocks (`knowledge-help-centre`, `-help-page`, `-native-help`,
  `-procedures`, `-native-procedures`, `-to-read`, `-native-to-read`, `-read-status`); admin
  screens Procedures, To read, the reader as a record screen, Read status; a record screen opened
  by `?record=`, a fixed-role account's record link sent to it; `cos add` brings Content's
  renderer whatever packs are listed; `publishable.staffNames` (a procedure's section's id, name and order with
  it) and `content.staffGet`'s `pictures`, so a pack-role account's screens make no refused call.
  Left: a pack-role account is not served a procedure's pictures (ADR 0708 names the host change).

- **Step 7** — not built — needs: step 1 — Passages and the assistant: chunking at headings,
  passage vectors, `content.passages`, citations

- **Step 8** — not built — needs: step 5 — Checklist "how to"

- **Step 9** — not built — needs: step 6, the first client — The first client: its procedures and
  its help pages on its site

- **Step 10a** — not built — needs: step 3, step 4 — Training through Courses, the platform: the
  staff own-row scope, the `training` source, the learners' reach, completion

- **Step 10b** — not built — needs: step 10a, step 5 — Training through Courses, `packs/courses`
  and Knowledge's training course field
