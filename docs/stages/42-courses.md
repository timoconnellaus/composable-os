# Stage 42: Courses

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md)
(Behaviours, Orders, Packs and blocks), [`CONTEXT.md`](../../CONTEXT.md), ADRs
[0404](../adr/0404-behaviours-are-the-vocabulary.md),
[0427](../adr/0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md),
[0429](../adr/0429-payments-gatekeeper-verified-events-and-refunds.md),
[0435](../adr/0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md),
[0438](../adr/0438-the-public-scope.md) to [0448](../adr/0448-programs-the-layout-assignments-and-the-log.md),
[0453](../adr/0453-pack-hooks-over-the-clients-operations.md) and
[0470](../adr/0470-the-import-door.md); stages [25](25-states-orders-payments.md),
[27](27-ticketing-and-ghetto.md), [28](28-content.md) and [41](41-programs.md); `packs/programs`,
`packs/content`, `packages/sdk/src/sellable.ts`, `packages/core/src/orders/`,
`packages/core/src/operations/media.ts`, `packages/gatekeeper-payments/src/`.

Status: **spec proposed** (2026-11-22). Not agreed: the interview settles the questions at the end
first. Builds on stages 25, 27, 28 and 41. The first client is a studio whose online program moves
off a hosted course platform onto its own stack, after tickets and before bookings
([roadmap](../roadmap.md), "How a module is built").

Where this spec guesses, it says **(guess)**. Nothing in it is decided until the interview.

## Goal

A studio sells video courses. A visitor browses the catalogue on the studio's site, grouped by
theme and level, and buys one course, a bundle of courses, or a monthly subscription that starts
with a free trial. They pay on the provider's page, and from then on they can watch the course's
lessons on the web and in the studio's app, mark them done and see how far they are. A lesson can
be a video, a page of text, a download, or a training session from Programs that they follow and
log. Nobody who has not paid can play a video, whatever they find in a page's source. Staff build
courses from the admin and see who is enrolled and how they are getting on. The studio's existing
students, their access and its videos move from the hosted platform with an import that can be run
again.

## What exists today (from the code)

- **Programs** (`packs/programs`, stage 41, ADR 0448). An exercise bank; `programs.program` with a
  `kind` that already has `course` (`packs/programs/index.ts`) and a layout document (weeks,
  sessions, blocks, items, typed sets, levels); publishable versions; `x.programs.assign` (staff,
  `bulk-write`) pins a version and makes one dated `programs.session` per session of the layout,
  each carrying its own plan; `programs.log` is one row per set, written by the member with
  `my.create` against a session they can see. Stage 41 decided that an online lesson is "a video,
  and optionally a follow-along session from Programs that the student tracks", and left the
  school's courses, lessons and sales to this stage. An exercise's demo video is a `url` field.
- **Content** (`packs/content`, stage 28, ADRs 0440 to 0444, 0470). `richText` (a fixed document
  schema; an `embed` block holds a YouTube or Vimeo address, `packages/sdk/src/rich-text.ts`);
  `publishable` with public reads of the current version (`content.get`, `content.list`, the
  `pub_x_*` views); slugs and redirects; preview links; the media library. **Media is pictures
  only**: JPEG, PNG, GIF, WebP or AVIF, at most 10 MB, read from the bytes; a PDF or a video is
  refused (`packages/core/src/operations/media.ts`). `media.serve` gives an outsider a picture
  only when the current version of a record they may read shows it in a field they may read
  (`core_published_media`, migrations 0461 and 0500). Both renderers (web and native) exist.
- **The import door** (ADR 0470). `cos content import <folder>` signs a staff person in for the
  run, uploads pictures over `POST /api/v1/media` (de-duplicated by SHA-256), and writes records
  with `record.import` (import keys, a dry run first, a person's edit reported as a conflict,
  `--publish` as the person's own choice). `record.import` takes extension objects only. People
  are imported with the CSV import (`import.csv.*`, ADR 0102).
- **Orders and payments** (stage 25, ADRs 0427 to 0429). `core_order` and its lines, priced by the
  host in one currency; guest checkout by email; paid only by a verified webhook; refunds through
  approval by a person with `orders:refund`. `gatekeeper-payments` has Stripe and a fake provider
  behind `PaymentProvider` (`createCheckout`, `getPayment`, `refund`, `verifyWebhook`); Stripe
  checkout is `mode=payment` only (`packages/gatekeeper-payments/src/stripe.ts`), and the events it
  reads are a completed checkout and refunds. **Nothing recurs**: no subscription, no stored card,
  no scheduled charge (stage 25, out of scope; roadmap stage 32).
- **`sellable`** (stage 27, ADR 0435). Price, sale window, most per order, deposit, and `grants`:
  one record of another of the pack's objects per unit, created by the host in the paid batch, and
  moved to `void` when the order is refunded in full or cancelled after a deposit. Only a pack or
  the org's own extension may declare it.
- **Scopes at the seam.** `customer` (own records), `public` (ADR 0438), `signedIn` (ADR 0447),
  `customerVia` (ADR 0439: what a customer reads of a record their own record points to, live,
  whatever its state). There is no scope for "a customer who has paid for this".
- **Customers** (stage 22). Sign in by emailed code; open or invite-only sign-up; a member's
  earlier account on a company's own system is linked by verified email at first sign-in (stage
  27). Pack roles (ADR 0436), permission grants (ADR 0449), hooks generic over the client's
  operations (ADR 0453), blocks in web and native skins with the block lint (ADR 0424).
- **The word "entitlement" is taken** (a hosted plan's limits, ADR 0211; CONTEXT.md). This spec
  says **access** for what a buyer holds.

## Scope: what the platform needs first

The manifest was written on paper first (`packs/courses` below). What it could not express is
this list. Each is host work, in the style of stage 41's "platform first" list, and is held for
every actor, the import and the approval queue's dry run.

### 1. Video in the media library
- **A `video` kind of media item**, kept in **Cloudflare Stream** on the deployment's own
  Cloudflare account (see "Where video lives" for why, and question 6). The `core_media` row holds
  the Stream video id, its state (uploading, processing, ready, failed), duration, dimensions, a
  poster frame and its caption tracks. Nothing of the video is in R2.
- **Upload goes straight to Stream, never through an operation or a Worker body.** A staff person
  asks for an upload (`media.videoUpload { name, size }`, a person only, as `media.upload` is) and
  gets a one-time direct upload address (resumable, tus, for large files); the admin's media
  library sends the file there. The host learns the video is ready from Stream's webhook or by
  asking (`media.videoRefresh`), and only then can a record point at it. Copying from an address
  (Stream's upload by link) is the import's way in (below). A file must be under 30 GB (Stream's
  limit). **(guess)**: whether the Workers binding covers uploads, or an API token with Stream
  rights is a host secret, is checked at build time.
- **Every video is stored with signed playback required.** A Stream id alone plays nothing.
- **A `video` field type** `{ media, poster? }`, like `image`: a document type with a fixed
  schema, its media id checked as a ref, and only a ready video may be named.
- **Captions:** staff upload a WebVTT file per language (Stream takes WebVTT only, at most 10 MB;
  an `.srt` from the old platform is converted by the import), or ask Stream to generate one in a
  language it supports; captions play with the video under the same token. **(guess)**: generated
  captions are a setting, off until an admin turns it on, because their price is not published.
- **A `file` kind of media item** for downloads (PDF only at first), in R2 like pictures, served by
  the same rule as pictures. **(guess)**: PDF is the only download type the first client needs.

### 2. Signed playback as a host rule
- **`media.play { id, record, field }`** (staff, customer, public; `read`) answers with a playback
  address and a token that expires (an hour by default, **guess**), or the one not-found. It
  follows the rule `media.serve` already follows for pictures: an outsider gets a token only for a
  video that the current version of a record they may read shows in a field, or part of a
  document, their scope lets them read. Who may read a course's lesson videos is the access rule
  (3, below). Staff get any ready video.
- **The token is made by the host**, either with the Stream Workers binding's `generateToken()`
  or signed with a Stream signing key held as a host secret, so playing a video costs no call to
  Stream's token API per view (that API is for low volume). A token may live at most 24 hours
  (Stream's limit); it does not allow downloads (`downloadable` is false). The key and its
  rotation are the deploy's (`cos deploy` makes it once, as it makes `CUSTOMER_AUTH_SECRET`).
  Videos also carry `allowedOrigins`: the company's web origins and the host's. **(guess)**: the
  binding is the build's first choice; the signing key is the fallback.
- **Phones ask the host itself** (`/api/v1/...`), as for pictures (ADR 0444, amended); a web app
  calls `media.play` over its binding. Blocks get an address and a token and never build either.
- **The trailer of a course is public**: a video in a public field of a published course plays for
  anyone, through the same operation.

### 3. Access: reading what you have paid for
A new scope at the seam, beside `customer`, `public`, `signedIn` and `customerVia`. **(guess)**:
its declaration is called `access`; the name is the build's.

- An object declares which of its fields, and which parts of a document field, are **for holders
  only**. The document field gains a node flag beside `private` (ADR 0445): a node marked
  `holders` is removed from what the public and customers without access read, exactly as a
  `private` node is removed from what every outsider reads.
- **A customer holds access to a record** when one of these is live, read in the host:
  1. a granted record of theirs pointing at it (an enrolment from a paid order line, or one staff
     gave), in its active state and inside its `until`, if it has one;
  2. a granted record of theirs pointing at a record that lists it (a bundle that contains the
     course);
  3. a subscription of theirs that is trialing or active, or cancelled with time left in the
     period they paid for, whose plan covers the record.
- **The rule is the host's alone.** A block, a hook and a client app are told what the caller may
  read and nothing more; no client decides that a lesson is open. `media.play` and the `lesson`
  read follow the same rule, from the same code.
- **A free preview** is a lesson the course marks as such: its parts are read by anyone who may
  read the course.
- **Refunds and cancellation** follow what exists: a full refund of a one-off order voids its
  enrolment (ADR 0435), so access ends in the same batch. A subscription's end is in 4.

### 4. Subscriptions (brought forward from stage 32)
Recurring billing is stage 32's. This stage needs the smallest part of it, and question 2 decides
whether it is built here. The proposal, for the recommended answer:

- **The provider runs the schedule.** A subscription is opened on the provider's own page
  (Stripe Checkout in subscription mode), and the provider keeps the card, charges each period,
  retries a failed charge and ends it when told. The platform stores no card and schedules no
  charge, as stage 25 decided. The host only learns, from verified events, what happened.
- **`sellable` gains `recurring: { interval, trialDays }`** for an object whose records are plans:
  price per period (a month), and the days of free trial, read from the record. **(guess)**: one
  interval, a month, is all the first client needs.
- **`core_subscription`, a base record**: the Person, the plan record, the provider's reference,
  the state, when the trial ends, the end of the period paid for, and whether it ends at that
  point. Its state machine is fixed in core: `incomplete` → `trialing` → `active` ↔ `past_due` →
  `cancelled` → `ended`, every move a `host` move made only from a verified provider event
  (`customer.subscription.*`, `invoice.paid`, `invoice.payment_failed`, **guess** at the exact
  event list). It declares `customer`, so a customer reads their own.
- **Each paid period is an order.** When the provider says a period's invoice is paid, the host
  writes a paid `core_order` with one line for the plan, in the deployment's currency, the
  provider's reference on it. Revenue, `rec_order`, the confirmation email and refunds stay one
  path. The trial's start is no order.
- **Starting and ending:** `subscription.start { planId, email? }` (customer, public) opens the
  provider's page, like `order.checkout`; `subscription.cancel { id }` (customer, their own; staff)
  asks the provider to end it at the end of the period paid for, through the gatekeeper;
  `subscription.portal` (customer) opens the provider's own page for changing the card. Cancelling
  at once, with or without a refund, is staff's, through approval, as refunds are.
- **One trial per Person** (guess, question 10): the host refuses a trial to a Person who has had
  one on that plan, and the provider's page then asks for the first payment straight away.
- **Stage 32 keeps the rest:** pauses, the `allowance` behaviour, plans that grant uses, charges
  the host schedules itself, proration and changing plans, and the Memberships pack.
- `gatekeeper-payments` gains the subscription checkout, the billing portal, the subscription
  events and the cancel action, for Stripe and the fake provider.

## Scope: the Courses pack (`packs/courses`)

### The model
On the hosted platform researched (see Sources), a course is **sections of learning activities**:
video, PDF and ebook, quizzes and exams, SCORM, assignments, live sessions, downloads and
certificates. Free previews are whole sections; drip opens sections by date or by days after
enrolment; completion is a rule the admin picks (all activities, chosen ones, passing an exam),
with a video counted done at a watched share (90 to 95% is their suggestion). This model keeps
that shape, and keeps only the kinds a studio's video program uses.

- A **course** is a publishable record with a title, a theme, a level, a description, a cover, an
  optional trailer, a price, and its **outline**: one document of **sections** of **lessons**,
  versioned and copied whole, as a program's layout is (ADR 0448).
- A **lesson** is one node of the outline with a key that never changes once published (progress
  is kept by it), a title, a duration, whether it is a free preview, and one **kind**:
  - `video`: a `video` value and notes in rich text;
  - `text`: rich text;
  - `session`: a published Programs program and one session of its layout, with an optional video
    to follow along to; the student follows it and logs it (question 9);
  - `download`: a `file` media item and a note.
  A lesson's title, kind, duration and preview flag are for everyone who may read the course; its
  video, rich text, session and file are for holders only.
- **A course is not a wrapper around a program** in this proposal: it has its own outline, and a
  Programs program is one kind of lesson inside it. Question 1 tests this against the first
  client's real courses.
- **Readers get the current version.** A student sees the course as it is published now (a fixed
  typo, a new lesson), unlike a Programs assignment, which pins its version. Progress survives a
  new version because it is kept by lesson key. A lesson removed from the outline keeps its
  progress rows and stops counting.
- **Progress** is one row per person and lesson: started, done, when, and where the video was
  left (seconds), so a player can resume. A course is **complete** when every lesson that is not
  a download is done. Done is marked by the student, or by the player when a video reaches its end
  (**guess**: the last 10 seconds count as the end).
- **Order and unlocking:** every lesson is open from the first day of access in this proposal.
  Drip (unlock by days) and finishing one lesson to open the next are question 11; if either is
  wanted it is part of the host's access rule, never the block's.
- **Themes and levels.** A theme is a record (name, order, slug); a level is a whole number from 1
  to 3 on the course. **(guess)**: three levels are enough for every client; the field's `max` is
  a pack setting if not.

### Objects
| Object | What | Behaviours |
| --- | --- | --- |
| `courses.theme` | Name, slug, order, short description, picture | `public` (every live one) |
| `courses.course` | Title, slug, theme, level, summary, description (`richText`), cover (`image`), trailer (`video`), price, **outline** (document) | `publishable` (all content fields) with `public`; `sellable` (grants an enrolment); access (holders' parts of the outline) |
| `courses.bundle` | Title, slug, description, cover, its courses (refs in a document, two to ten **guess**), price | `publishable` with `public`; `sellable` (grants an enrolment of the bundle) |
| `courses.plan` | Title, description, price per month, trial days, what it covers (every published course in this proposal, question 3) | `public`; `sellable` with `recurring` |
| `courses.enrolment` | Its Person, its course or bundle, its order, where it came from (`purchase`, `staff`, `import`), from and until | `states` (`active`, `ended`, `void`); `customer: person`; `customerVia` the course and the bundle |
| `courses.progress` | Its Person, course, lesson key, state (`started`, `done`), when started and done, position in seconds | `customer: person`; written by the tools with `my.create` and `my.update` |

A subscription is the core `core_subscription`, not a pack object, because stage 32's memberships
use the same record. A Programs session a lesson makes is a `programs.session`, not a copy.

### Tools (operations)
Tools are `x.courses.<tool>`. None holds a rule the host already holds.
- `catalogue { theme?, level? }` (public): published courses, bundles, plans and themes with their
  prices and the deployment's currency, through `public.list`.
- `course { slug }` (public): one published course: its fields, the outline's public parts, and,
  for a signed-in customer, whether they hold access and their progress.
- `lesson { courseId, lessonKey }` (customer; staff): the lesson's holders' parts and, for a video,
  a playback token from `media.play`; the one not-found without access.
- `progress { courseId, lessonKey, state?, position? }` (customer): marks started or done, keeps
  the position; refused without access.
- `myCourses` (customer): every course the caller holds access to and why (bought, bundle,
  subscription, given), with progress per course.
- `buy { courseId | bundleId, email? }` (customer, public): `order.start` for one line; the buyer
  then calls `order.checkout`. Refused, as the record that does not exist, for a course the caller
  already holds (**guess**: no buying twice).
- `subscribe { planId, email? }` (customer, public): `subscription.start`.
- `enrol { personId, courseId | bundleId, until?, reason }` (staff, `write`, permission
  `courses:enrol`, grantable): access given by staff (a complimentary place, a fix), with who and
  why on the record.
- `endEnrolment { enrolmentId, reason }` (staff): ends an enrolment staff gave or one imported. A
  bought one ends by refund, as every grant does.
- `stats { courseId? }` (staff, read): enrolments, active subscribers, trials, completion and
  lessons done by week, for the dashboard and the assistant.
- `draft { brief }` (staff): the assistant's draft of a course's outline and lesson text as a
  working copy, built only from videos already in the library and programs already published; it
  never publishes.
- `startSession { courseId, lessonKey }` (customer): for a `session` lesson, the caller's
  `programs.session` for it, made if it does not exist (question 9 decides how).

### Staff side, from the host
- Themes, courses, bundles, plans, enrolments and progress in the admin with lists, record pages
  and saved views: "Published courses", "Drafts", "Enrolments this month", "Trials ending this
  week", "Subscriptions past due".
- The **media library** shows videos with their state, duration and captions, and uploads them.
- A **Courses** dashboard: active subscribers and trials, trials that became paid, cancellations
  by month, revenue by month split by one-off, bundle and subscription, enrolments by course,
  lessons done by week, students with nothing done in two weeks. Its numbers are checked against a
  fixture worked out by hand, as Programs' are.
- A Person's page gets a **Courses** tab (their enrolments, subscription and progress) and their
  orders and subscription moves post to their timeline.

### Headless hooks and blocks
Hooks (`@composable-os/pack-courses/client`), generic over the client's operations (ADR 0453):
`useCatalogue`, `useCourse`, `useLesson`, `usePlayback` (asks again before the token expires),
`useProgress`, `useMyCourses`, `useBuy`, `useSubscribe`, `useMySubscription`, `useCancel`, and for
staff `useEnrol` and the course builder's pure outline edits (`outlineEdits`, as Programs'
`layoutEdits`).

| Block | Skin | What |
| --- | --- | --- |
| Catalogue | web, native | Courses by theme and level, bundles, the plan; prices from the host |
| Course page | web, native | The description, trailer, outline with lesson titles and durations, free previews, and buy or subscribe (web), or "open" for a holder |
| Player | web, native | A lesson: video with captions and resume, rich text, a download, or the session (Programs' session block inside it); mark done; next lesson |
| My courses | web, native | What the caller holds, with progress, and continue where they left off |
| Subscription | web | The caller's plan, trial end, next charge date, cancel, and the provider's portal for the card |
| Course builder | web (staff) | Sections and lessons by drag and keyboard, videos and files picked from the library, rich text, sessions picked from published programs, preview flags, versions and publish |

The native blocks take the video player as a prop, as Ticketing's take the camera, so they depend
on no device package. **(guess)**: the app passes `expo-video` with the signed HLS address.

### AI
- The assistant may draft a course (outline, lesson titles, descriptions, notes in rich text) as a
  working copy with `draft`, write a theme's text, and report on enrolments and progress with
  `stats` and the `rec_*` views. It never uploads a video (an upload is a person's).
- **Publishing a course follows whatever the platform's publish rule is.** Today `record.publish`
  is a person's with `records:publish`, never an AI actor (ADR 0446). The owner is deciding
  whether an AI may *ask* for a publish that a person then approves. This stage adds nothing to
  that rule and depends on neither answer: a course, a bundle and a plan are published through
  `record.publish` like any publishable record, so whatever is decided for it applies here
  unchanged. The acceptance criterion below is written for both.
- Refunds, cancelling a subscription at once and giving access are as the platform already has
  them: an AI may propose, a person with the permission approves.

## Where video lives

| | Cloudflare Stream, signed playback (proposed) | R2, served by the host | Stays on an outside host (links) |
| --- | --- | --- | --- |
| Playback | Adaptive streaming (HLS, DASH) to every device; the Stream player or any HLS player | One file per video, progressive; no lower quality on a slow phone unless the studio encodes several | The outside host's player |
| Who may watch | A short-lived token the host signs only for a holder; an id alone plays nothing | The host streams bytes only to a holder, every range request through a Worker | The outside host's privacy settings; the host cannot hold the rule |
| Cost (list prices, check at build) | $5 a month per 1,000 minutes stored, $1 per 1,000 minutes delivered; encoding and bandwidth free | Storage only; no egress fee; Worker requests per range | The outside host's plan |
| Captions | WebVTT upload or generated | Our own track files | The outside host's |
| Offline | MP4 downloads can be allowed per video | The file itself | No |
| Work | Upload and token signing in the host | Encoding outside the platform, range serving | None, and no rule |

A worked example, **(guess)** at the numbers: 60 hours of lessons stored is 3,600 minutes; 300
students watching 3 hours a month is 54,000 minutes delivered. At Stream's list prices that is
about $18 a month for storage and $54 for delivery: the bill grows with how much people watch,
not with how many courses there are.

Stream is proposed because the access rule must be the host's (ADR 0404), and signing a short
token is the only one of the three where a leaked page source or a shared link stops working
within the hour. R2 alone would make the host a video server; an outside host cannot know who has
paid.

**Offline on native** is question 7. Stream can make an MP4 download of a video, given a token
that allows it, but the token does not travel with the file, so a video downloaded to a phone is
protected only by the app's own storage. Stream's documentation names no DRM **(guess: none)**.
Hosted platforms that offer offline viewing keep it narrow: the platform researched allows MP4
downloads in its branded app only, Wi-Fi by default, with progress made offline not synced.

## Selling: what is reused as built
- **One course and one bundle are ordinary sellable records.** `order.start`, guest checkout,
  `order.checkout`, the verified webhook, the confirmation email, refunds through approval and the
  `void` on a full refund all work as built. The grant is one `courses.enrolment`. Nothing new in
  orders for these two.
- **A bundle** grants one enrolment that points at the bundle, and access reaches its courses
  through it (rule 3.2). Question 4 decides whether a bundle is a fixed set or "any three".
- **Deposits, sale windows and most per order** are not used by courses. A course's sale window is
  available if a studio wants a launch date.
- **Refunds.** A full refund of a course or a bundle voids its enrolment and ends access in the
  same batch. A partial refund changes nothing about access. Refunding one period of a
  subscription refunds that period's order and changes nothing about the subscription; ending it
  is a separate staff action. **(guess)**: that is the right default; it is not a question because
  staff can always do both. (The platform researched does the opposite for one-off sales: a
  refund leaves access unless the admin also unenrols. Here the grant's void is already the
  platform's rule, ADR 0435.)
- **Tax** is left out as stage 25 left it, unless question 14 says otherwise.
- **Buying in the app** is question 8. Stage 25's note stands: a store may require its own payment
  for digital content used inside an app, and a course is digital content.

## Migration from a hosted course platform

Follow the shape of `cos content import` (ADR 0470): a folder in the platform's own shapes, checked
whole before signing in, a dry run on the host, import keys so a second run changes only what the
source changed, a person's edit never overwritten, and publishing as the person's own choice.

### What moves, and how
- **Courses and their outlines:** `cos courses import <folder>`. One JSON file per course in the
  platform's shapes (the outline document, rich text as `RICH_TEXT_SCHEMA`), with a video named by
  `file` (a file in `videos/`) or `url` (an address Stream copies from), pictures and downloads by
  file name, themes and levels by name. The platform researched says plainly that "entire courses
  cannot be exported as a single file"; its API lists a course's sections and units
  (`/v2/courses/{id}/contents`), but only on its higher plans, and whether it returns the content
  itself is not confirmed. So the first client's converter writes the folder from that API or by
  hand, and the folder check lists what did not convert.
- **Videos:** uploaded to Stream once, found again by a hash or by the source's id, so a re-run
  uploads nothing. No export of original video files was found in the provider's documentation
  **(guess: there is none)**, so the originals come from the studio's own files, or from a
  connected Vimeo or Wistia account if the school used one, by Stream's copy from a link
  (question 13).
- **People:** the CSV import of people (`import.csv.*`, ADR 0102) with its "same email" match. No
  customer account and no password moves: a student signs in with their email by code and finds
  their courses, as the ticketing members were linked (stage 27). No mail is sent by the import.
- **Access:** `people.csv`'s companion `access.csv` (email, course or bundle key, from, until,
  where it came from) becomes `courses.enrolment` records with source `import`, through
  `record.import` with import keys. They are not orders: no order is invented for money taken
  elsewhere.
- **Purchase history** is kept as the provider's export, not imported as orders **(guess)**:
  orders are what this host was paid.
- **Progress** (question 13): lesson-by-lesson progress moves only if the provider exports it per
  user per learning activity, and lessons can be matched by key. The platform researched exports
  progress per course as a report (on its middle plans) and per user through its API (on its
  higher plans); its users export is a CSV whose columns are not documented. Otherwise a completed
  course is imported as completed and the rest starts fresh.

### Active subscriptions
A subscription is an agreement between the buyer, the card and **one Stripe account**. It cannot
be moved to another account without the buyer, and nothing in this platform will charge a card
that the buyer did not give to the studio's own account.

Where the subscriptions are: the platform researched connects the school's own Stripe account,
and each of its subscriptions is a subscription in that account. When the school sits inside
another business's storefront, that account is likely the other business's **(guess: the first
question to the provider)**. The real options (question 12):

1. **Copy the cards with Stripe and recreate each subscription.** Stripe's self-serve copy moves
   customers and their saved payment methods from one account to another, done by both account
   holders in the Dashboard, usually within 72 hours, with a CSV mapping old to new. It does not
   copy subscriptions, prices, invoices or coupons. Each subscription is created again on the
   studio's account (Stripe's billing migration toolkit: a CSV with the start set to the old
   period's end), and the old one is cancelled before it charges, so nobody pays twice. European
   and UK cards saved without strong authentication may be declined when charged without the
   buyer present. This needs the old account's owner to take part, which is harder when it is
   another business whose account holds its own customers too.
2. **Ask each subscriber to subscribe again on the studio's site**, with their first new period
   free until the date they have already paid up to (a trial set to that date), then cancel the
   old one at its period end. Nobody pays twice; some will not come across.
3. **Let the old subscriptions run down**: new subscribers only on the new site, the old ones
   served on the old platform until they cancel. Simplest, longest period of running both.

### A period where both run
- The new catalogue opens to new buyers on a set day; the hosted school keeps serving everyone who
  is there until a cut-over date.
- Imported access is in place before the first email to students; the email tells them to sign in
  with the same address.
- After the cut-over, the hosted school's addresses point to the new catalogue, and its videos are
  removed from the old host.

### What to ask the current provider (and the storefront's owner)
- Whose Stripe account takes the school's payments and holds its subscriptions, and whether its
  owner will ask Stripe to copy the subscribers' cards to the studio's account.
- An export of users (name, email, sign-up date, tags), of enrolments per course with their dates
  and expiry, of transactions, and of active subscriptions with each one's next renewal date.
- Lesson-level progress per user, if it exists in an export or the API.
- The original video files, or confirmation that the studio holds them; captions.
- Whether the course structure (sections, learning activities, their order and text) can be
  exported, or must be read from the API or copied.
- The notice period and the date the school's plan renews, which sets the cut-over.

## What the first client's setup would then be
- The Courses pack and Programs on in the studio's product, Content already on.
- Its themes and levels, its courses with videos in Stream, two or three fixed bundles, and one
  monthly plan with a free trial, all published by a person.
- The catalogue, course page, subscription and my-courses blocks on the studio's web app; the
  catalogue, my courses and player in its app, signing in through the host as tickets already do.
- The Stripe account the studio already uses for tickets, now also taking subscriptions.
- Its students, their access and, if they can be had, their progress imported; the subscriptions
  moved by whichever option question 12 picks.

## Out of scope
- Quizzes, assignments, SCORM, interactive video, live classes inside a course.
- Certificates of completion **(guess: not needed first)**.
- Discussions, comments and community.
- Coupons, discounts and gift purchases (stage 34); "any three" bundles if they need `allowance`
  (stage 32).
- Pauses, plan changes, proration, yearly plans, and charges the host schedules (stage 32).
- More than one language; DRM.
- Payment inside the native app through a store, unless question 8 says otherwise.
- Tax, unless question 14 says otherwise.

## Acceptance criteria
1. **Pack on the contract:** Courses is built only on the public contract and the typed client,
   passes `cos ext check` and `cos ext test`, and a product without it has none of its objects.
2. **Video upload:** a staff person uploads a video through a direct upload address; the media
   item is ready only once Stream says so; a record naming a video that is not ready is refused;
   an MCP client, the assistant and an automation cannot ask for an upload.
3. **Signed playback:** a holder gets a token that plays; it stops working after its expiry; a
   customer without access, the public and a made-up id get the one not-found; a video id with no
   token does not play (checked against Stream in a by-hand run with a runbook); a public trailer
   plays for anyone.
4. **Access, one-off:** against the fake provider, buying a course grants one enrolment in the
   paid batch; the buyer then reads the outline's holders' parts and plays its videos; a full
   refund voids the enrolment in the refund's batch and the next `lesson` read is not-found.
5. **Access, bundle:** buying a bundle gives access to each of its courses and to no other.
6. **Access, subscription:** a fake subscription that is trialing or active gives access to every
   course the plan covers; `past_due` keeps it **(guess)**; cancelled at period end keeps it until
   that date and not a minute after; `ended` gives none. Every state move is a host move from a
   verified event, and a repeated event changes nothing.
7. **Each paid period is an order:** two paid invoices give two paid orders with the plan's
   price; refunding one goes through approval and leaves the subscription as it was.
8. **One trial per Person:** a second trial for the same Person on the same plan is refused, and
   the provider's page asks for payment.
9. **The rule is the host's:** the stage 22 isolation test covers enrolments, progress and
   subscriptions; a customer's `my.get` of a course without access returns no holders' part; the
   block lint passes for every block, and no block decides access.
10. **Progress:** marking a lesson done, resuming a video at its position, and completing a course
    work; progress survives a new published version that keeps the lesson's key.
11. **Session lessons:** a holder opens a `session` lesson, gets their own Programs session, and
    logs sets against it with Programs' own tools; a person without access cannot.
12. **Import:** `cos courses import` of a fixture folder (two courses, a bundle, five people,
    their access, three videos by file and by address) imports as drafts in one dry-run-checked
    run; a second run changes and uploads nothing; a person's edit since is a conflict and kept;
    imported students sign in by code and see their courses; nothing was mailed.
13. **AI:** over MCP, the assistant drafts a course from a brief with only library videos and
    published programs; it cannot publish it directly; under whatever publish rule the platform
    then has (a person only, or an AI's request a person approves), the course becomes public only
    after a person's act.
14. **Dashboard:** the Courses dashboard's numbers match a fixture worked out by hand.
15. `pnpm lint typecheck test` and one e2e test per journey (a visitor buys a course and watches a
    lesson; a visitor starts a trial and is shown every course; staff build and publish a course)
    pass in CI. ADRs, `CONTEXT.md` (Course, Lesson, Enrolment, Access, Subscription, Plan, Bundle,
    Progress, Video) and `docs/architecture.md` are updated.

## Dependencies
- Stages 25, 27 and 28 (merged) and 41 (steps 1 to 6 merged).
- Stage 32: this stage builds the provider-run subscription only if question 2 says so, and stage
  32 then builds on `core_subscription` rather than beside it. If question 2 says wait, criterion
  6 to 8 move to stage 32 and this stage ships one-off and bundle sales only.
- A Cloudflare Stream subscription on the deployment's account (a person sets it up; `cos deploy`
  checks it, **guess**).

## Migrations and numbers
Migrations 0510 to 0519 (video and file media, `core_subscription` and its history, the access
scope's tables if it needs any; the pack's tables come from the reconciler). ADRs 0475 to 0479.
Claimed in [`parallel-work.md`](../parallel-work.md) as block AE.

## Suggested build order
1. Video media in Stream: direct upload, the ready state, the `video` field, captions; the `file`
   kind.
2. Signed playback (`media.play`) on the existing picture rule.
3. The access scope at the seam, with enrolments as the first source, and the holders' node flag
   on the document field; the isolation test.
4. The pack's objects, the outline schema, `buy`, `lesson`, `progress`, `myCourses`; the buy,
   refund and bundle tests.
5. Subscriptions (if question 2 says build): the gatekeeper's subscription checkout and events
   against the fake provider, `core_subscription`, an order per paid period, the plan as an access
   source; then Stripe in test mode by hand, with a runbook.
6. Session lessons on Programs.
7. The dashboard, views, the Person tab; hooks; web blocks, then native blocks; the course
   builder.
8. The assistant's draft; `cos courses import`.
9. The first client: its courses imported, its students and access, the subscriptions moved, the
   period where both run, the cut-over.

Steps 1 to 3 are the spine: video that only a holder can play, and the one rule that says who is a
holder.

## Proposed defaults, open to override at the interview
Not questions, because a sensible default answers them; listed so they can be overruled.
- **Courses requires Programs** (a lesson can be a session). A product without Programs cannot
  turn Courses on. **(guess)**: no client wants courses without Programs soon.
- **Readers see the current published version**, and progress is kept by lesson key.
- **Lifetime access for a one-off purchase**, unless question 5 says otherwise.
- **Prices are the record's**, in the deployment's one currency, read by the host.
- **Every staff member sees every student's progress** until stage 14a, as Programs has it.
- **The course builder is a block in the company's web app**, as Programs' builder is (ADR 0401);
  videos are uploaded in the host's media library and picked from it.

## Questions for the interview
Ordered by how much each changes the build.

1. **What is one of today's online programs, structurally?** The model depends on it.
   - (a) Lessons, each a video (and some text), sometimes with a training session to follow: the
     course owns its outline and a Programs session is one kind of lesson (this proposal; stage
     41's decision).
   - (b) A multi-week Programs program whose sessions each carry a video: the course is a wrapper
     that sells a program, and its "lessons" are the program's sessions.
   - (c) Both kinds exist.
   **Recommended: (a), checked against two real programs before the build starts.** The model in
   (a) holds (b) as a course whose lessons are all `session` lessons, so (c) costs nothing more;
   (b) alone would tie video and sales into Programs' layout schema, which every class and client
   program shares.

2. **Subscriptions: build the smallest part here, or wait for stage 32?**
   - (a) Wait: stage 42 sells one course and bundles; the subscription waits for stage 32.
   - (b) Bring forward a provider-run subscription: the provider keeps the card, charges, retries
     and ends it; the host keeps `core_subscription` from verified events, an order per paid
     period, and access from it. Stage 32 adds pauses, allowances, plan changes and memberships on
     top of the same record.
   - (c) Build recurring billing in full now (charges the host schedules, its own retries), as
     stage 32 is sketched.
   **Recommended: (b).** The first client's subscription is most of its online revenue **(guess)**,
   so (a) would move it without its main way of paying; (c) is stage 32's whole job and holds this
   one up. (b) is what stage 41 did with `publishable`: the part needed now, built so the later
   stage extends it.

3. **What does a subscription cover?**
   - (a) Every published course, including ones added later.
   - (b) A chosen list of courses per plan.
   - (c) Several plans, each covering a theme or a level.
   **Recommended: (a), with the plan's "what it covers" designed as a choice so (b) can follow.**
   It is the simplest rule to hold and to explain, and the first client has one plan **(guess)**.

4. **What is "a bundle of three"?**
   - (a) A fixed set staff choose (these three courses, one price).
   - (b) Any three courses the buyer picks, for one price.
   - (c) Both.
   **Recommended: (a).** It is an ordinary sellable record that grants one enrolment. (b) is a
   credit of three spent on courses, which is stage 32's `allowance`; built here it would be a
   second, smaller allowance. Within (a), access reaches the bundle's courses live, so a course
   added to a bundle later reaches earlier buyers too (as the platform researched does for its
   "learning programs", not its "bundles", which grant only what was in them at purchase).
   **(guess)**: live is right; the interview may say "as bought".

5. **How long does a one-off purchase give access?**
   - (a) For as long as the course is offered (lifetime).
   - (b) A fixed time from purchase (for example a year), the same for every course.
   - (c) Set per course.
   **Recommended: (a)**, with `until` on the enrolment kept so (c) is a field later. It is what
   buyers of a one-off course expect, and nothing has to end on its own.

6. **Where do the videos live?**
   - (a) Cloudflare Stream on the studio's own account, with signed playback.
   - (b) R2, streamed by the host to holders.
   - (c) Stay on an outside video host, linked from lessons.
   **Recommended: (a).** It is the only one where the host holds who may watch and a shared link
   dies within the hour, and it gives every phone adaptive playback. Its cost grows with minutes
   watched; the build checks the current prices before the client commits.

7. **Can students watch offline in the app?**
   - (a) No: streaming only.
   - (b) Yes: a lesson can be downloaded in the app, kept in the app's own storage, and checked
     against access whenever the phone is online.
   - (c) Not now, designed for later.
   **Recommended: (a) now, (c) in the design.** A downloaded file is out of the host's reach (no
   DRM), and offline adds storage, expiry and a second player path to the native blocks.

8. **Can people buy inside the app?**
   - (a) No: buying is on the web; the app signs in and plays what the account holds, with no
     price or buy button.
   - (b) Yes, through Apple's and Google's in-app purchases: a second payment path whose
     subscriptions live in the stores, and the stores' share of each sale.
   - (c) A link out to the web from the app, where the store's rules for the app's countries allow
     it.
   **Recommended: (a)**, with the stores' current rules read at build time (stage 25's note).
   Video courses are digital content used in the app, which the stores have treated differently
   from tickets; (b) is a second payment system and a stage of its own. The platform researched
   sells in its branded app through the stores' purchases, without bundles or coupons there, so
   students moving from it may be used to buying in the app **(guess)**.

9. **A lesson that is a training session: how is it tracked?**
   - (a) Marked done only; no sets logged.
   - (b) The student logs sets with Programs' own tools: when they first open a course with
     session lessons, it assigns them the program from that day (the dates as a suggested pace),
     and its sessions are where they log.
   - (c) As (b), but with undated, self-paced sessions, which Programs does not have and would
     gain.
   **Recommended: (b).** It uses Programs as built (stage 41 decided online students "can log
   sets"); (c) is cleaner for a self-paced student but is new Programs work, and can follow if
   dated sessions confuse people.

10. **The free trial: what are its rules?**
    - (a) Card taken at the start, first charge when the trial ends unless cancelled, one trial per Person.
    - (b) No card at the start; when the trial ends, access stops until they pay.
    - (c) Card taken at the start, no limit on trials.
    **Recommended: (a).** The platform researched gives one trial per learner per product and
    rolls into billing when it ends (whether it takes a card first is not documented); the
    provider's page supports (a) directly; one trial per Person, by the platform's email match,
    stops the easiest abuse. Cancelling during the trial keeps access until it ends.

11. **Should lessons unlock over time or in order?**
    - (a) No: everything is open from the first day of access.
    - (b) In order: a lesson opens when the one before it is done.
    - (c) By days: a lesson opens a set number of days after access began (drip).
    **Recommended: (a) for the first build.** (b) and (c) are rules the host must hold in the
    access check (never the block), and they matter most for a subscription the student could
    otherwise binge and cancel; if the first client uses drip today, (c) is the one to build. The
    platform researched drips by section, by date or by days after enrolment, and lets staff
    unlock a learner early; sequential order and prerequisites are on its paid tiers.

12. **How do the active subscribers move?**
    - (a) Stripe copies their cards to the studio's account, each subscription is recreated with
      its next charge on the old renewal date, and the old one is cancelled.
    - (b) Each subscriber subscribes again on the new site, free until the date they have paid up
      to, and the old one ends at its period end.
    - (c) Old subscriptions run down on the old platform; only new subscribers use the new site.
    **Recommended: (b), unless the old Stripe account is the studio's own, in which case (a).**
    (a) needs the old account's owner to agree and Stripe's migration team; when the school sits
    inside another business's storefront and account, (b) is the one the studio controls, and it
    charges no card the buyer did not give the studio. (c) means running both for as long as the
    longest subscriber stays.

13. **What moves from the hosted platform besides courses?**
    - (a) People and their access; progress starts fresh, except courses already completed.
    - (b) Also lesson-by-lesson progress, if the provider exports it.
    - (c) Also past purchases, as orders.
    **Recommended: (a), and (b) only if the export has it per learning activity.** Access is what
    students would notice missing; progress is a nicety that depends on the provider's export, and
    orders on this host should be money this host was paid. Video originals come from the studio's
    own files if it has them.

14. **Tax on digital sales**
    - (a) Leave it out, as stage 25 did: prices are what the buyer pays, and the studio's own copy
      says whether they include tax.
    - (b) Turn on the provider's tax calculation at checkout and on subscription invoices.
    **Recommended: (a) for this stage**, with the studio's accountant asked first, because selling
    digital services to buyers in other countries can carry obligations that tickets for a place
    do not **(guess)**; (b) is a setting on the gatekeeper's checkout if the answer is yes.

## Sources
Read 2026-11-22. Some LearnWorlds facts come from the official help pages' search summaries where
the page body would not load; the API reference (learnworlds.dev) could not be read.

- LearnWorlds, course structure and activity kinds:
  [learning activities](https://support.learnworlds.com/support/solutions/articles/5000652836-learning-activities-supported-by-learnworlds),
  [creating courses](https://support.learnworlds.com/support/solutions/articles/12000079954-general-overview-creating-courses),
  [free sections](https://support.learnworlds.com/support/solutions/articles/12000091420-how-to-offer-free-sections-in-a-paid-course),
  [navigation and prerequisites](https://support.learnworlds.com/support/solutions/articles/12000106609-how-to-customize-courses-learning-paths-with-navigation-and-prerequisite-rules),
  [drip feed](https://support.learnworlds.com/support/solutions/articles/12000041912-how-to-drip-feed-your-courses),
  [course statuses](https://support.learnworlds.com/support/solutions/articles/12000040783-different-course-statuses-in-learnworlds).
- LearnWorlds, completion:
  [completion rules](https://support.learnworlds.com/support/solutions/articles/12000053453-how-to-customize-the-learning-activities-completion-rules),
  [certificate of completion](https://support.learnworlds.com/support/solutions/articles/12000087212-how-to-create-a-certificate-of-completion).
- LearnWorlds, selling:
  [bundles](https://support.learnworlds.com/support/solutions/articles/5000688439-how-to-create-a-course-bundle),
  [learning programs](https://support.learnworlds.com/support/solutions/articles/12000104343-how-to-create-learning-programs-in-learnworlds),
  [subscription plans and trials](https://support.learnworlds.com/support/solutions/articles/12000085681-a-complete-guide-to-subscription-plans-in-learnworlds),
  [cancelling a subscription](https://support.learnworlds.com/support/solutions/articles/12000056686-how-learners-can-cancel-their-subscription-plan),
  [refunds](https://support.learnworlds.com/support/solutions/articles/12000051256-how-to-refund-your-users-payments-via-learnworlds),
  [Stripe gateway](https://support.learnworlds.com/support/solutions/articles/12000030238-stripe-payment-gateway).
- LearnWorlds, video:
  [video storage](https://support.learnworlds.com/support/solutions/articles/5000687089-video-provider-storage-preferences-learnworlds-wistia-vimeo-),
  [subtitles](https://support.learnworlds.com/support/solutions/articles/12000065858-how-to-add-subtitles-and-transcripts-to-your-videos),
  [offline in the app](https://support.learnworlds.com/support/solutions/articles/12000089188-how-to-allow-mobile-app-users-to-download-and-watch-videos-offline),
  [mobile app FAQ](https://support.learnworlds.com/support/solutions/articles/12000079754-mobile-apps-faqs).
- LearnWorlds, export:
  [exporting school data](https://support.learnworlds.com/support/solutions/articles/12000077153-how-to-download-export-your-school-data),
  [users report](https://support.learnworlds.com/support/solutions/articles/12000024925-how-to-export-users-report),
  [progress reports](https://support.learnworlds.com/support/solutions/articles/12000076855-user-progress-user-segments),
  [payments export](https://support.learnworlds.com/support/solutions/articles/12000016424-how-to-track-and-review-your-users-payments),
  [API](https://support.learnworlds.com/support/solutions/articles/12000017230).
- Cloudflare Stream:
  [securing videos (signed URLs, tokens, signing keys, the binding)](https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/),
  [pricing](https://developers.cloudflare.com/stream/pricing/),
  [captions](https://developers.cloudflare.com/stream/edit-videos/adding-captions/),
  [uploading](https://developers.cloudflare.com/stream/uploading-videos/),
  [upload by link](https://developers.cloudflare.com/stream/uploading-videos/upload-via-link/),
  [MP4 downloads](https://developers.cloudflare.com/stream/viewing-videos/download-videos/).
- Stripe:
  [copying customers and cards between accounts](https://docs.stripe.com/get-started/data-migrations/pan-copy-self-serve),
  [migrating subscriptions](https://docs.stripe.com/billing/subscriptions/migrate-subscriptions),
  [billing migration toolkit](https://docs.stripe.com/billing/subscriptions/import-subscriptions-toolkit),
  [subscriptions with Connect](https://docs.stripe.com/connect/subscriptions).

Not found in a primary source, and marked as guesses above: whether LearnWorlds exports original
video files; its users CSV's columns; an export of subscriptions (they are in the Stripe account);
its exact API paths and whether the API returns lesson content; how it connects to Stripe (Connect
or keys, direct charges or not); whether a trial needs a card; what refunding a subscription does
to access; the price of Stream's generated captions; how Stream counts MP4 downloads (its pages
disagree); and the app stores' current rules for the first client's countries.
