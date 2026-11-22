# Importing content

`cos content import` loads posts and their pictures from another system (an old blog) into a
host, as the person who runs it. It is the platform's door for writing content from a script
([ADR 0470](adr/0470-the-import-door.md)): every write is an operation that person's session calls,
checked and audited as theirs. `cos courses import` is the same door for a course platform's
courses, videos and students' access ([below](#courses-cos-courses-import), ADR 0495), and `cos
subscriptions offers import` for subscribers moving from another platform
([below](#subscribers-cos-subscriptions-offers-import), ADR 0491).

```bash
cos content import ./export --host https://admin.example.com              # by the browser
cos content import ./export --host https://admin.example.com --email you@example.com
cos content import ./export --host https://admin.example.com --dry-run    # checks, writes nothing
cos content import ./export --host https://admin.example.com --publish    # asks, then publishes
cos content import ./export --host https://admin.example.com --publish --yes   # from a script
```

## What it does

1. Reads the folder and checks every post and picture (below). Any problem stops the run before
   anyone signs in, with each problem and its file.
2. Signs you in for this run only: with `--email`, the host emails a staff code (the host's own
   sign-in); without it, your browser opens the host's staff sign-in (Cloudflare Access, Google)
   and hands a one-time code back to a port on `127.0.0.1` the command listens on. The session is
   held in the command's memory, nowhere else, and ended on the host when the run finishes. No
   token is read from a file or the environment, or printed.
3. Checks every record on the host as it would be written (`record.import` with `dryRun`): the
   host's own field rules. A problem here stops the run too, with nothing written.
4. Uploads the pictures the library does not have (by the SHA-256 of their bytes), then writes
   the categories and the posts. With `--dry-run` it stops before this and says what would
   happen.
5. With `--publish`, after asking (or with `--yes`): publishes each post whose `status` is
   `published`, and schedules each `scheduled` one for its `date` (one whose time has passed is
   published). Without `--publish`, every post is a draft, and the report says which were
   published or scheduled in the source.

Run it again whenever you like. A post is matched by its **import key** (below), not its title:

- a key seen before whose record still holds what the import wrote: the fields the source changed
  are updated, and nothing else; unchanged, nothing is written;
- a record someone has edited since the import (any field the import wrote), or deleted: a
  **conflict**, reported with the fields, and left as it is;
- a new key whose address (slug) another post already has: a conflict, never a second post;
- a published post publishes again only when its content changed.

Pictures are never uploaded twice: the library knows each file by its hash.

## The folder

```
export/
  opening-night.json      one post per file; the file name (without .json) is its import key
  second-week.json
  pictures/
    hall.jpg              the pictures the posts name, by file name
    cover.png
```

A post file is one JSON object:

| Field | | What |
| --- | --- | --- |
| `key` | optional | The import key. Default: the file name without `.json`. 1 to 200 letters, digits or `._:-`. Keep it the same between runs. |
| `title` | required | Text, at most 1,000 characters. |
| `slug` | optional | The address: lowercase letters and digits in words joined by hyphens (`opening-night`). Default: made from the title. Two posts may not share one. |
| `excerpt` | optional | Text. |
| `body` | optional | Rich text in the platform's own shape (`RICH_TEXT_SCHEMA`, ADR 0440), with one difference: a picture block names its file, `{ "type": "image", "file": "hall.jpg", "alt": "…" }`, where the stored shape has `media`. |
| `cover` | optional | `{ "file": "cover.png", "alt": "…", "focal": { "x": 0.5, "y": 0.3 } }` (`focal` optional, 0 to 1). |
| `date` | optional | ISO 8601 date and time with its zone (`2021-03-01T09:00:00Z`): the date readers are shown. Kept when published, so old posts keep their dates and the public list stays in their order. |
| `status` | optional | `draft` (default), `scheduled` (needs `date`) or `published`. Acted on only with `--publish`. |
| `category` | optional | The category's name. Categories are made from the names, once each. |
| `byline` | optional | Who wrote it, as readers see it (`Words by Sam Lee`). |
| `seoTitle` | optional | The title for search engines and link previews. |
| `seoDescription` | optional | The description for them. |
| `seoImage` | optional | The share picture, as `cover`. |
| `noindex` | optional | `true` asks search engines not to list the post. |

Any other field is a problem. A picture must be in `pictures/`, a JPEG, PNG, GIF, WebP or AVIF by
its bytes (not its name), at most 10 MB; SVG is not taken.

Example:

```json
{
  "title": "Opening night",
  "slug": "opening-night",
  "excerpt": "Doors at seven.",
  "body": {
    "blocks": [
      { "type": "paragraph", "content": [{ "type": "text", "text": "The hall was full." }] },
      { "type": "image", "file": "hall.jpg", "alt": "The hall from the stage" }
    ]
  },
  "cover": { "file": "cover.png", "alt": "The stage" },
  "date": "2021-03-01T09:00:00Z",
  "status": "published",
  "category": "News",
  "byline": "Words by Sam Lee",
  "seoTitle": "Opening night at the hall",
  "seoDescription": "How the first night went.",
  "noindex": false
}
```

## What the host needs

- The Content pack installed (`content.post`, `content.category`).
- You are a staff member. Publishing needs the publish permission (admins have it; an admin grants
  it to a member).
- For the browser sign-in, the host lists the command's loopback address,
  `http://127.0.0.1/cos-sign-in`, in `NATIVE_REDIRECT_URIS` (no port: the command picks one each
  run). `cos deploy` sets it on every host, and the CRM's installer when it is unset. The host's
  page asks you to confirm before the sign-in goes to the command
  ([ADR 0457](adr/0457-confirm-your-email-and-confirm-the-native-sign-in.md)).
- For `--email`, your address is one an admin invited, or one you confirmed (your account menu,
  "Confirm your email"; an admin who signed up with a password must do this once), and the host's
  sign-in mail is on (Settings → Users, "Send sign-in codes without review"). The host answers the
  same whoever asks, so if no code arrives, check these on the host.
- Behind Cloudflare Access nothing else: the command calls `/api/v1/*` (the HTTP surface, already
  bypassed) and uploads to `POST /api/v1/media`, which takes a staff device token only
  ([docs/deploying.md](deploying.md#what-stays-behind-access-and-what-is-bypassed)).

## In local development

Content and Ticketing are not packs the CRM lists, so local dev delivers them (with Programs and
the box office fixture) as the org's own extensions, optional ones (`scripts/dev-setup.mjs`), the
way `cos deploy` delivers a client's. Install Content once as an admin, from Settings → Extensions
or with `extension.install { id: "content", shipped: true }`, before an import. Do not add them to
the runner's `COS_PACKS`: an org extension and a pack may not share an id, so the runner refuses
the whole list ("The org's extension content has a pack's id"). On a client host, the product's
`packs` list names Content and `cos deploy` sets `COS_PACKS` from it.

## On a post's page

The pack's `postHead(post, { siteName, url, origin })` (from `@composable-os/pack-content/client`)
gives a published post's head: its title (the search title, else the title), description (else
the excerpt, else the start of the body), share picture (else the cover), canonical address and
`noindex`. The `content-post` block's `PostHead` renders it as React 19 `<title>` and `<meta>`
elements, which React hoists into the document's head. In TanStack Start, render `<PostHead>`
beside `<PostArticle>`, or return the same values from the route's `head()`. In an Astro page,
call `postHead()` in the frontmatter and write the tags in `<head>`:

```astro
---
const answer = await host.call("content.get", { object: "content.post", slug: Astro.params.slug });
const head = postHead(answer, { siteName: "The Hall", url: Astro.url.href, origin: Astro.url.origin });
---
<head>
  <title>{head.title}</title>
  {head.description && <meta name="description" content={head.description} />}
  {head.image && <meta property="og:image" content={head.image.url} />}
  {head.robots && <meta name="robots" content={head.robots} />}
  {head.canonical && <link rel="canonical" href={head.canonical} />}
</head>
```

## Courses: `cos courses import`

`cos courses import` loads a studio's courses, bundles and their videos from a hosted course
platform, with each student's access, completed courses and lesson-by-lesson progress
([ADR 0495](adr/0495-the-courses-import.md), stage 42). It goes through the same door as the content
import and runs on the same code (`packages/create-composable-os/src/import-door/`). The folder is
checked whole before anyone signs in, and the sign-in lasts for the run only. `record.import`'s
dry run checks every record on the host. Records are matched by import keys, conflicts are reported
and never overwritten, and publishing is the person's own choice.

```bash
cos courses import ./export --host https://admin.example.com --dry-run    # checks, writes nothing
cos courses import ./export --host https://admin.example.com              # as drafts
cos courses import ./export --host https://admin.example.com --publish    # asks, then publishes
cos courses import ./export --host https://admin.example.com --wait 60    # waits up to an hour
```

`--email`, `--publish` and `--yes` work as they do for content. The command exits 0 when
everything is in, 1 on a problem (nothing written), 2 on a wrong command line, and 3 when some
courses wait for Stream (below).

### What it does

1. Reads the folder and checks it (below). Any problem stops the run before signing in. Each
   problem names its file, and for a CSV row its line (`access.csv:7`).
2. Signs you in for the run (as for content).
3. Finds each student on the host by email, and each session lesson's program. Checks every
   theme, course and bundle on the host as it would be written (`record.import` with `dryRun`),
   with placeholders standing in for media not yet uploaded. A problem stops the run with nothing
   written. `--dry-run` stops here and says what would happen.
4. Uploads the pictures and downloads the library does not have (by the SHA-256 of their bytes),
   and the videos (below), each with its captions.
5. Waits for Stream to have the videos ready (`--wait <minutes>`, 10 by default), showing what is
   left. Then writes the themes, each course whose videos are all ready, the bundles whose courses
   are all written, the enrolments and the progress.
6. With `--publish`, after asking, publishes each course and bundle whose `status` is `published`.
   One already published with the same content is left as it is. Without `--publish` every course
   is a draft, and the report says which were published in the source.

**A course whose videos are not ready is not written.** A published course with a video Stream
cannot play would sell a lesson no one can watch. The report names each course still waiting and
the command exits 3. Running the same command again later writes it: the videos are found by their
hash, nothing is uploaded twice, and the rest of the run changes nothing. A bundle waits for its
courses the same way.

### Videos

A lesson's or trailer's video is a file in `videos/` or an `https` address:

- **A file** is hashed (SHA-256, read from disk a chunk at a time) and uploaded to Stream on a
  one-time address (`media.videoUpload`). A file up to 200 MB goes in one post. A larger one goes
  in resumable (tus) chunks, and the command shows the progress as it goes. When a chunk fails,
  the command asks Stream how much it has and carries on from there, up to five times in a row. A
  file may be up to 30 GB.
- **An address** (a file the old platform, Vimeo or Wistia serves) is copied by Stream itself
  (`media.videoFromUrl`, Stream's copy from a link), so nothing passes through your computer.
  Stream must be able to fetch the address without signing in.

Each video is kept with the hash of its file (or of `url:<address>`), so a re-run finds it and
uploads nothing. Suppose a stopped run left a video half-sent (`uploading`), or Stream could not
take it (`failed`): the video is removed and sent again from the start, and the report says so.
Captions go up with the video, through `POST /api/v1/media/<id>/captions`, which takes a staff
device token only.

### Students: how a row finds its person

People are imported first, with the people CSV import (Settings → Import, `import.csv.*`), which
matches by email. The courses import then finds each row's student by its `email`, lowercased: the
one person on the host with that address.

- **No person has it** (not imported, or the address was erased when the person asked to be
  forgotten): the row is listed in the report with its file and line, and nothing is made for it.
  The import never creates a person and never sends mail.
- **Two people have it**: this cannot happen on a host, where an address is unique. If it ever
  did, the row would be listed ("merge them first"), never guessed.
- A student keeps signing in with that address, by a code sent by email. No password or account
  moves.

### Access, completions and progress

- **Access** (`access.csv`): each row becomes a `courses.enrolment` for its person and a course or
  a bundle. It has source `import`, the row's `from` and `until`, and the key
  `<email>|course:<key>` (or `bundle:<key>`). No order is made, and nothing is charged or
  refunded. An `until` in the past is kept, so the student has no access, as before.
- **Completed courses**: `completed` (`yes`, `true` or `1`) marks the enrolment completed.
- **Progress** (`progress.csv`): each row becomes a `courses.progress` for its person, course and
  lesson, matched by the lesson's `sourceId`. It has source `import` and the key
  `<email>|<course>|<sourceId>`.
- **A row whose lesson no `sourceId` matches** (the new outline dropped it) is listed with its file
  and line, and the rest imports.
- **A student's own progress is kept.** Suppose the student has their own row for that lesson
  because they watched it on the new site. The imported row is then a conflict, reported and left
  as it is. So is a row the import wrote that has changed since.
- **Without `progress.csv`**, the completed courses are completed and every other course starts at
  its first lesson. The report says so, and names each course that had access but no progress to
  bring.

### The folder

```
export/
  courses/handstands.json    one course per file; the file name (without .json) is its import key
  bundles/all-access.json    one bundle per file
  videos/wrists.mp4          the videos the courses name by `file`
  captions/wrists.srt        their captions: WebVTT, or SubRip (.srt, converted)
  pictures/cover.png         covers, and pictures in rich text
  downloads/sheet.pdf        download lessons' files (PDF)
  access.csv                 who holds what
  progress.csv               lesson by lesson, when the old platform exports it
```

A course file:

| Field | | What |
| --- | --- | --- |
| `key` | optional | The import key. Default: the file name. Keep it the same between runs (the old platform's id). |
| `title`, `price` | required | The price in the major unit (`99` is 99.00). |
| `slug`, `summary`, `level` | optional | `level` 1 to 3. The slug defaults to one made from the title. |
| `description` | optional | Rich text (`RICH_TEXT_SCHEMA`), a picture as `{ "type": "image", "file" }`. |
| `cover` | optional | `{ "file": "cover.png", "alt": "…" }`. |
| `trailer` | optional | A video (below). |
| `theme` | optional | The theme's name. Each name is made into a theme once. |
| `outline` | required | `{ "sections": [{ "key", "title", "lessons": [...] }] }`. |
| `status` | optional | `draft` (default) or `published`, acted on with `--publish`. |

Every lesson has these fields:

- `kind`: `video`, `text`, `session` or `download`.
- `key`: lowercase letters, digits and `-`, unique in the course.
- `title`.
- Optionally `minutes`, `preview` (a free preview) and `sourceId` (its id on the old platform,
  unique in the course, which `progress.csv` names).

Then each kind has its own fields:

- A `video` lesson has `video` and `notes` (rich text).
- A `text` lesson has `body`.
- A `session` lesson has `program` (a published Programs program's id or exact title), `week` and
  `session`.
- A `download` lesson has `file` (in `downloads/`) and `note`.

A video is `{ "file": "wrists.mp4" }` or `{ "url": "https://…" }`. It may also have
`"captions": [{ "language": "en", "file": "wrists.srt", "label": "English" }]`.

A bundle file has `key`, `title`, `price`, `slug`, `summary`, `description`, `cover` and `status`,
and `courses`, which lists the courses' keys.

`access.csv` starts with a header row. Its columns may come in any order, and extra ones are
ignored:

| Column | | What |
| --- | --- | --- |
| `email` | required | The student's address. |
| `course` or `bundle` | one of them | The course's or bundle's key in the folder. |
| `from`, `until` | optional | Dates (`2024-05-01`) or dates and times with their zone. |
| `completed` | optional | `yes` when the student finished the course. |

`progress.csv` has three required columns: `email`, `course` (its key) and `lesson` (the lesson's
`sourceId`). Three more are optional: `state` (`done`, the default, or `started`), `done_at`, and
`position` (seconds into the video).

### What the host needs

- The Courses pack (and Programs, which it requires) installed, and the students already imported
  as people.
- You are staff. `--publish` needs the publish permission.
- Stream configured on the host ([docs/stream-runbook.md](stream-runbook.md)). Behind Cloudflare
  Access nothing else is needed, as for content.

## Subscribers: `cos subscriptions offers import`

People subscribed on another platform cannot have their cards moved here (stage 32's "Moving
members' billing"). Instead each subscribes again, free until the date they have already paid up
to there, and the company ends the old subscription at its period's end. Each person's
**continuation offer** is imported with this command ([ADR 0491](adr/0491-continuation-offers.md),
[ADR 0492](adr/0492-a-continuation-replaces-the-trial.md), stage 32a). It goes through the same
door: the file is checked before anyone signs in, the sign-in lasts for the run, and the host
checks every row in a dry run before anything is written.

```bash
cos subscriptions offers import offers.csv --host https://admin.example.com --plan courses.plan --dry-run
cos subscriptions offers import offers.csv --host https://admin.example.com --plan courses.plan --invite
cos subscriptions offers report --host https://admin.example.com --status taken --out taken.csv
```

`--plan` is the plan's object; when it has more than one record, `--plan courses.plan:<id>` (the
command lists them). `--email` works as for content. The command exits 0 when every row is in, 1
when some rows were not written (listed with their line) or on a problem in the file (nothing
sent), and 2 on a wrong command line.

### The file

A CSV with a header row; its columns may come in any order, and extra ones are ignored:

| Column | | What |
| --- | --- | --- |
| `email` | required | The person's address, as on the other platform. |
| `paid_up_to` (or `free_until`) | required (a real day and time: `2026-02-30` or `T24:00` is refused with its line) | The date they have paid up to (`2026-12-15`): 00:00 that day in the organisation's time zone, the day the old platform would charge next. Or a moment with its zone (`2026-12-15T09:00:00+10:00`). |
| `reference` | optional | The other platform's reference for the old subscription, shown in the report so you can find it there. |

### What it does

- **People come first.** Import them as people (the CSV import) before their offers. An address is
  matched to the one live person who has it; an address nobody has is listed with its line
  (`offers.csv:7`) and nobody is created; one that two people share is listed until they are
  merged.
- **The address is the key.** A re-run changes nothing. A changed date updates an offer not yet
  taken. An offer taken or withdrawn since, or with a checkout the payment provider says is still
  open on the old date, is a conflict: reported, never overwritten. A checkout the provider says
  expired no longer counts, so the correction is written. If the provider cannot be asked, the row
  is reported and left until a later run.
- **A withdrawal made by mistake.** A withdrawn offer stays withdrawn. To give that person a fresh
  offer, run the import again with `--reissue`: the fresh offer sits beside the withdrawn one, and
  both show in the report.
- **A file that changes underneath.** If someone takes or withdraws an offer while the import is
  writing it, nothing of that batch is written and the command sends it again, which then reports
  what is true now.
- **Dates too close, or past.** With under 48 hours to the date (the payment provider's floor for
  free time), taking the offer is charged at once. A date that has passed is imported (the report
  shows it) but cannot be taken: the person subscribes as anyone does. The report notes both.
- **The free trial.** No trial while a person has an offer they can still take, or while the
  subscription from one has not ended. A continuation is not the trial: after it has ended, or if
  the offer expired untaken, the plan's trial is theirs once, as for anyone who never had it.
- **Signing in.** Only the person signed in as the offer's address can take it: never a guest who
  types it, never staff for them. An imported person has no customer account yet. With customer
  sign-up `open` they can sign up; with `invite_only` or `buyers` they cannot unless invited.
  `--invite` invites each address (it needs the `users:manage` permission, as inviting does), which
  works under every setting. A separate change, not yet merged, adds a customer sign-in setting
  "anyone starting a subscription" (any address may get a code while a plan is on sale, people
  already in the records included); with it on, imported subscribers can sign in without invites.
  Nothing is emailed: tell your people to sign in on the site with that address and continue their
  subscription there.
- **What they see.** The subscribe block shows a signed-in member their offer ("Continue, free
  until 15 Dec 2026") in place of the free trial. The provider's page takes the card now and
  charges it first on that date. No free trial is ever added.

### The report

Subscriptions → Continuation offers in the admin (and `cos subscriptions offers report`): who has
taken their offer, with the date their new subscription starts charging; who has not; which
expired or were withdrawn; and Download CSV. **End the old subscription of everyone taken, at its
period's end**, and chase the rest before their date. Withdraw an offer made in error there.

### What the host needs

- A plan (for courses, a course plan) and the people already imported.
- You are staff with `subscriptions:manage` (admins have it), and `users:manage` for `--invite`.
- Payments with the company's own provider account, set up and tried in test mode first
  ([docs/subscriptions-stripe-runbook.md](subscriptions-stripe-runbook.md)).
