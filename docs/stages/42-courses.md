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

Status: **spec agreed** (interview 2026-11-23; proposal merged as PR #190). Builds on stages 25,
27, 28 and 41. The first client is a studio whose online program moves off a hosted course
platform onto its own stack, after tickets and before bookings ([roadmap](../roadmap.md), "How a
module is built"). Subscriptions are stage 32's; this stage sells single courses and fixed
bundles.

Where this spec still guesses, it says **(guess)**; the build confirms or corrects each one.

## Goal

A studio sells video courses. A visitor browses the catalogue on the studio's site, grouped by
theme and level, and buys one course or a bundle of courses on the provider's page, with tax
worked out by the provider at checkout. From then on they can watch the course's lessons on the
web and in the studio's app, mark them done and see how far they are. A lesson can be a video, a
page of text, a download, or a training session from Programs that they follow and log. Nobody who
has not paid can play a video, whatever they find in a page's source. Staff build courses from the
admin and see who is enrolled and how they are getting on. The studio's existing students, their
access, their progress where it can be had, and its videos move from the hosted platform with an
import that can be run again.

## Decided at the interview (2026-11-23)

| Question | Decision |
| --- | --- |
| What a program is today | **Lessons, each a video (and some text), sometimes with a training session to follow.** The course owns its outline; a Programs session is one kind of lesson. *Precondition:* checked against two of the client's real programs before build step 4 (the outline schema) |
| Subscriptions | **Wait for stage 32 (Memberships).** This stage sells single courses and fixed bundles only. No subscription, trial or per-period order is built here; the access scope is designed so a subscription is a third source later without changing the seam |
| Bundles | **A fixed set staff choose, at one price.** Not "pick any three" |
| How long a one-off purchase lasts | **For as long as the course is offered.** The enrolment keeps an `until` field, empty by default |
| Where video lives | **Cloudflare Stream on the company's own account, with signed playback** |
| Offline in the app | **No, not now.** Designed so it can be added (see "Video", below) |
| Buying in the app | **No: web only.** The app signs in and plays what the account holds, with no price and no buy button |
| A lesson that is a training session | **Logged with Programs' own tools, as an assigned program**: assigned when the student first opens the course, from that day, the dates a suggested pace |
| Unlocking over time or in order | **No.** Every lesson is open from the first day of access |
| What the import takes | **People, access, completed courses, and lesson-by-lesson progress when the old platform's export has it** (see "Migration") |
| Tax | **The provider's tax calculation is turned on at checkout** for online sales. It is a setting and behaviour of the payments gatekeeper and orders, scoped in its own section below |
| Tax on tickets (follow-up, 2026-11-23) | **Yes: tax is calculated on tickets too.** Ticket types declare a tax code like courses; deposits and balances are taxed payment by payment (section 4) |
| Today's subscribers (follow-up, 2026-11-23) | **They stay on the hosted platform until stage 32 is built; the hosted school takes no new subscribers once the new site opens.** Two places run until stage 32 (see Migration) |

### Decided for stage 32 (recorded now so they are not asked again)
These were answered at this interview and are stage 32's to build. The roadmap's stage 32 row
points here.

| Question | Decision |
| --- | --- |
| What a subscription to courses covers | **Every published course, including ones added later** |
| The free trial | **A card is taken at the start; the first charge is when the trial ends unless cancelled; one trial per Person** |
| Today's subscribers on the hosted platform | **Each subscribes again on the new site, free until the date they have already paid up to, and the old subscription ends at its period end** |
| Until stage 32 is built (follow-up, 2026-11-23) | **Today's subscribers stay on the hosted platform; the hosted school takes no new subscribers once the new site opens.** Stage 32's move is of that closed, shrinking group |

### Defaults not ruled on at the interview, open to override
- **A bundle's courses are read live (guess).** Access reaches the courses the bundle lists now, so
  a course added to a bundle later reaches earlier buyers too, and one removed stops. The owner did
  not rule on this; the other reading ("what was in it when bought") is a snapshot of refs on the
  enrolment.
- **Courses requires Programs** (a lesson can be a session). A product without Programs cannot
  turn Courses on.
- **Readers see the current published version**, and progress is kept by lesson key.
- **Prices are the record's**, in the deployment's one currency, read by the host.
- **Every staff member sees every student's progress** until stage 14a, as Programs has it.
- **The course builder is a block in the company's web app**, as Programs' builder is (ADR 0401);
  videos are uploaded in the host's media library and picked from it.
- **Prices are tax-inclusive** (see "Tax at checkout"), tickets included.
- **Certificates of completion are left out** (no one asked for them).

## What exists today (from the code)

- **Programs** (`packs/programs`, stage 41, ADR 0448). An exercise bank; `programs.program` with a
  `kind` that already has `course` (`packs/programs/index.ts`) and a layout document (weeks,
  sessions, blocks, items, typed sets, levels); publishable versions; `x.programs.assign` (staff,
  `bulk-write`) pins a version and makes one dated `programs.session` per session of the layout,
  each carrying its own plan; `programs.log` is one row per set, written by the member with
  `my.create` against a session they can see. An exercise's demo video is a `url` field.
- **Content** (`packs/content`, stage 28, ADRs 0440 to 0444, 0470). `richText` (a fixed document
  schema; an `embed` block holds a YouTube or Vimeo address, `packages/sdk/src/rich-text.ts`);
  `publishable` with public reads of the current version; slugs; preview links; the media
  library. **Media is pictures only**: JPEG, PNG, GIF, WebP or AVIF, at most 10 MB, read from the
  bytes; a PDF or a video is refused (`packages/core/src/operations/media.ts`). `media.serve`
  gives an outsider a picture only when the current version of a record they may read shows it in
  a field they may read (`core_published_media`, migrations 0461 and 0500).
- **The import door** (ADR 0470). `cos content import <folder>` signs a staff person in for the
  run, uploads pictures over `POST /api/v1/media` (de-duplicated by SHA-256), and writes records
  with `record.import` (import keys, a dry run first, a person's edit reported as a conflict,
  `--publish` as the person's own choice). `record.import` takes extension objects only. People
  are imported with the CSV import (`import.csv.*`, ADR 0102).
- **Orders and payments** (stage 25, ADRs 0427 to 0429). `core_order` and its lines, priced by the
  host in one currency; guest checkout by email; paid only by a verified webhook, whose amount and
  currency must match the order or nothing moves; refunds through approval by a person with
  `orders:refund`. `gatekeeper-payments` has Stripe and a fake provider behind `PaymentProvider`
  (`createCheckout`, `getPayment`, `refund`, `verifyWebhook`); Stripe checkout is `mode=payment`
  with inline `price_data` and no tax settings (`packages/gatekeeper-payments/src/stripe.ts`).
  Stage 25 left tax out ("prices are what the buyer pays"). Nothing recurs.
- **`sellable`** (stage 27, ADR 0435). Price, sale window, most per order, deposit, and `grants`:
  one record of another of the pack's objects per unit, created by the host in the paid batch, and
  moved to `void` when the order is refunded in full or cancelled after a deposit.
- **Scopes at the seam.** `customer`, `public` (ADR 0438), `signedIn` (ADR 0447), `customerVia`
  (ADR 0439). There is no scope for "a customer who has paid for this".
- **Customers** (stage 22). Sign in by emailed code; a member's earlier account on a company's own
  system is linked by verified email at first sign-in (stage 27). Pack roles (ADR 0436),
  permission grants (ADR 0449), hooks generic over the client's operations (ADR 0453), blocks in
  web and native skins with the block lint (ADR 0424).
- **The word "entitlement" is taken** (a hosted plan's limits, ADR 0211). This spec says
  **access** for what a buyer holds.

## Scope: what the platform needs first

The manifest was written on paper first (`packs/courses` below). What it could not express is
this list. Each is host work, held for every actor, the import and the approval queue's dry run.

### 1. Video in the media library
- **A `video` kind of media item**, kept in **Cloudflare Stream** on the deployment's own
  Cloudflare account. The `core_media` row holds the Stream video id, its state (uploading,
  processing, ready, failed), duration, dimensions, a poster frame and its caption tracks. Nothing
  of the video is in R2.
- **Upload goes straight to Stream, never through an operation or a Worker body.** A staff person
  asks for an upload (`media.videoUpload { name, size }`, a person only, as `media.upload` is) and
  gets a one-time direct upload address (resumable, tus, for large files); the admin's media
  library sends the file there. The host learns the video is ready from Stream's webhook or by
  asking (`media.videoRefresh`), and only then can a record point at it. Copying from an address
  (Stream's upload by link) is the import's way in. A file must be under 30 GB (Stream's limit).
  **(guess)**: whether the Workers binding covers uploads, or an API token with Stream rights is a
  host secret, is checked at build time.
- **Every video is stored with signed playback required.** A Stream id alone plays nothing.
- **A `video` field type** `{ media, poster? }`, like `image`: a document type with a fixed
  schema, its media id checked as a ref, and only a ready video may be named.
- **Captions:** staff upload a WebVTT file per language (Stream takes WebVTT only, at most 10 MB;
  an `.srt` from the old platform is converted by the import), or ask Stream to generate one in a
  language it supports. **(guess)**: generated captions are a setting, off until an admin turns it
  on, because their price is not published.
- **A `file` kind of media item** for downloads (PDF only at first), in R2 like pictures, served by
  the same rule as pictures.

### 2. Signed playback as a host rule
- **`media.play { id, record, field }`** (staff, customer, public; `read`) answers with a playback
  address and a token that expires (an hour by default, **guess**), or the one not-found. It
  follows the rule `media.serve` already follows for pictures: an outsider gets a token only for a
  video that the current version of a record they may read shows in a field, or part of a
  document, their scope lets them read. Who may read a course's lesson videos is the access rule
  (3). Staff get any ready video.
- **The token is made by the host**, with the Stream Workers binding's `generateToken()` or signed
  with a Stream signing key held as a host secret, so playing costs no call to Stream's token API
  per view. A token lives at most 24 hours (Stream's limit). Videos carry `allowedOrigins`: the
  company's web origins and the host's.
- **Offline is designed in, not built.** `media.play` takes a `purpose` with one value now,
  `stream`; a later `download` purpose would ask for a token with Stream's `downloadable` set,
  under the same access rule, and the native player is a prop of the blocks, so an offline player
  can replace it. No download token is issued in this stage.
- **Phones ask the host itself** (`/api/v1/...`), as for pictures (ADR 0444, amended); a web app
  calls `media.play` over its binding. Blocks get an address and a token and never build either.
- **A course's trailer is public**: a video in a public field of a published course plays for
  anyone, through the same operation.

### 3. Access: reading what you have paid for
A new scope at the seam, beside `customer`, `public`, `signedIn` and `customerVia`. **(guess)**:
its declaration is called `access`; the name is the build's.

- An object declares which of its fields, and which parts of a document field, are **for holders
  only**. The document field gains a node flag beside `private` (ADR 0445): a node marked
  `holders` is removed from what the public and customers without access read, as a `private`
  node is removed from what every outsider reads.
- **A customer holds access to a record** when one of these is live, read in the host:
  1. an enrolment of theirs pointing at it (from a paid order line, from staff, or imported), in
     its active state and inside its `until`, if it has one;
  2. an enrolment of theirs pointing at a bundle that lists it.
- **Sources are a list, and the seam asks one question.** The declaration names its sources
  (`{ via: "courses.enrolment", field: "course" }`, `{ via: "courses.enrolment", field: "bundle",
  through: "courses" }`), and the seam's one function, "does this customer hold access to this
  record", answers from them. Stage 32 adds a subscription as a third kind of source (a live
  `core_subscription` whose plan covers the record) to that list; the seam's interface, the
  holders' node flag and `media.play` do not change. A test names this: a fixture source of a
  third kind, added in the test only, is honoured with no change to the seam.
- **The rule is the host's alone.** A block, a hook and a client app are told what the caller may
  read and nothing more. `media.play` and the `lesson` read follow the same rule, from the same
  code.
- **A free preview** is a lesson the course marks as such: its parts are read by anyone who may
  read the course.
- **A full refund voids the enrolment** (ADR 0435), so access ends in the same batch. A partial
  refund changes nothing about access.

### 4. Tax at checkout (payments and orders, for courses and tickets)
Asked for by the owner for online sales, and then for tickets too (follow-up, 2026-11-23). It is
work in `gatekeeper-payments` and in orders (stage 25); Courses and Ticketing each opt in by
declaring a tax code.

- **What turns it on:** a deployment setting (`order.settings.tax`, human admin only, **off until
  turned on**), and, per sellable object, a tax code declared in its manifest (`sellable.tax: {
  code }`, the provider's product tax code). A line is taxed only when both are on.
- **The packs' default codes**, from Stripe's current product tax code list (read 2026-11-23,
  [tax codes](https://docs.stripe.com/tax/tax-codes)); the company may change either:
  - Courses (`courses.course`, `courses.bundle`): `txcd_20060158`, "On demand Online Courses -
    pre-recorded audio or audio visual content (streamed)": "accessed through a SaaS platform,
    streamed to internet connected devices, and is not available for download". It matches no
    offline viewing; when offline is built, the list has a "streamed and downloadable" code
    (`txcd_20060258`) to move to.
  - Ticketing (`ticketing.tickettype`): `txcd_50010001`, "Admission to Amusement, Entertainment &
    Recreation Venues – Participant": "charges for admission to amusement, recreation, or
    entertainment venues where the entrant participates in activities, excluding sports
    activities". **(guess)**: participant, not spectator, fits most events a studio sells (a camp,
    a workshop). The list also has spectator, sporting-event, professional-event and fitness
    codes; a camp that includes a room may need another treatment altogether. Which applies is
    the company's call with its accountant.
- **Changing a code** is a human admin's, per object, in Settings → Orders
  (`order.settings.taxCodes`, overriding the manifest's default), audited. **(guess)**: per
  object is enough; a code per record (one ticket type a workshop, another a camp with lodging)
  is a field the build can add if the first client's events need it.
- **Prices are tax-inclusive.** The price on the record, and a ticket type's deposit, is what the
  buyer pays; the provider works out the tax inside it. So the amount the host asks for is the
  amount the provider charges, and stage 25's rule that a verified payment must match holds as
  built. Tax-exclusive prices would make the charge differ by the buyer's location and would need
  that rule changed: not built. Stripe cannot change a price's tax behaviour once set.
- **At checkout** the gatekeeper opens the provider's page with automatic tax on, each line's tax
  code and `tax_behavior: inclusive`, and the billing address required, because the buyer's
  location sets the rate. The address is typed on the provider's page and not stored by the host.
- **Where an event happens.** For admission to an in-person event, many tax systems tax it where
  the event is, not where the buyer lives, which may differ from online courses (where the buyer
  is). The gatekeeper passes the event's place to the provider when the provider takes one.
  **(guess, check at build)**: whether Stripe Tax can be given the event's address as the place of
  the service at Checkout (its reports carry a "performance location", which suggests it can);
  if it can, a ticketing event gains a structured address for tax (country, region, postcode)
  beside its free-text `venue`. If it cannot, the build says so and stops for a decision before
  tickets are taxed. **Which place of supply applies, and where to register, is the company's and
  its accountant's matter, not something this spec or the platform advises on.**
- **On the order:** each verified payment event carries the provider's tax amount; the host
  stores it on that payment (`core_order_checkout`, beside its amount) and the order's running
  tax (`taxAmount`, minor unit) with the country or place it was charged for, in the payment's
  batch. Totals are unchanged. `rec_order` and `rec_order_line` gain the columns; dashboards show
  sales net of tax. Where the company is not registered, the provider charges none and the order
  says zero.
- **Deposits and paying the balance in parts** (stage 25): there is no schedule; each payment is
  its own checkout for its own amount. Tax is worked out on each payment as it is made, inclusive,
  at the line's code, so a deposit carries its share of the tax and each part of the balance its
  share. The sum may differ from tax on the whole price by a minor unit per payment; the order
  keeps what the provider charged, never a recomputed figure. Whether a deposit is taxable when it
  is paid is the rule of the place of supply, which the provider applies; again the company's
  accountant's matter. A buyer may give a different billing address at a later payment; for an
  in-person event, if the event's place is passed, the rate does not move with them.
- **Refunds.** A refund is of one payment (stage 25), full or partial, and the provider reduces
  the tax it reported for that payment in proportion; the host records the refunded amount as now
  and the tax refunded from the provider's refund event when it carries it **(guess at the
  field)**. A **part-paid order** is cancelled first, as built (its tickets voided and places
  released), and then each of its payments is refunded as its own action; each refund reverses
  that payment's own tax. Nothing about who may refund changes.
- **Unchanged:** holds and capacity (places are claimed and released exactly as before), the door
  and check-in, tickets and their codes, grants and voids, guest checkout and the order's states.
  The Ticketing pack's change is its manifest's tax code; its checkout block shows the provider's
  tax line on the confirmation when there is one, and its prices are shown as before, because
  they are what the buyer pays.
- **For the first client's ticket sales already designed:** prices shown stay what the buyer pays
  (inclusive); turning tax on changes what the company keeps, not what a buyer sees or pays.
  Turning it on mid-sale changes nothing for orders already paid; a part-paid order's later
  payments are taxed from then on **(guess: acceptable; the company may prefer to switch between
  events)**.
- **The receipt** is the provider's, which itemises tax; the host's confirmation email states the
  tax amount when there is one. Invoices stay stage 35's.
- **What the company sets up itself, on its own Stripe account** (not the platform's work; listed
  in the runbook): turning on Stripe Tax and its origin address; **registering with each tax
  authority where it must collect**, for online courses and for each place it holds events, and
  adding each registration in the Stripe Dashboard (Stripe collects only where a registration is
  active); checking or changing the packs' default codes; who files and pays the returns (Stripe
  reports; filing is the company's or a partner's). Stripe Tax's own fee is the company's (0.5% a
  transaction where it is registered, at list price, for Checkout, **check at build**). A host
  that turns the setting on without registrations charges no tax anywhere; the setting's screen
  says so and links the runbook.

## Scope: the Courses pack (`packs/courses`)

### The model
On the hosted platform researched (see Sources), a course is **sections of learning activities**:
video, PDF and ebook, quizzes and exams, SCORM, assignments, live sessions, downloads and
certificates. This model keeps that shape, and only the kinds a studio's video program uses.

- A **course** is a publishable record with a title, a theme, a level, a description, a cover, an
  optional trailer, a price, and its **outline**: one document of **sections** of **lessons**,
  versioned and copied whole, as a program's layout is (ADR 0448).
- A **lesson** is one node of the outline with a key that never changes once published (progress
  is kept by it), a title, a duration, whether it is a free preview, an optional `sourceId` (its
  id on the old platform, for the import), and one **kind**:
  - `video`: a `video` value and notes in rich text;
  - `text`: rich text;
  - `session`: a published Programs program and one session of its layout, with an optional video
    to follow along to;
  - `download`: a `file` media item and a note.
  A lesson's title, kind, duration and preview flag are for everyone who may read the course; its
  video, rich text, session and file are for holders only.
- **Readers get the current version.** A student sees the course as it is published now; progress
  survives a new version because it is kept by lesson key. A lesson removed from the outline keeps
  its progress rows and stops counting.
- **Progress** is one row per person and lesson: started, done, when, and where the video was left
  (seconds), so a player can resume. A course is **complete** when every lesson that is not a
  download is done, or when it was imported as completed. Done is marked by the student, or by the
  player when a video reaches its end (**guess**: the last 10 seconds count as the end).
- **Every lesson is open from the first day of access.** No drip, no order.
- **Session lessons** (decided): when a holder first opens a course that has session lessons, the
  pack assigns them each program those lessons use, from that day (`x.programs.assign`, as an
  automation on the first progress row, run as the extension; **guess**: a few seconds' delay is
  acceptable, and the player says "preparing your sessions" meanwhile). The lesson then opens the
  student's own `programs.session`, and they log sets with Programs' tools. The dates are a
  suggested pace; nothing is refused for doing a session on another day.
- **Themes and levels.** A theme is a record (name, order, slug); a level is a whole number from 1
  to 3 on the course.

### Objects
| Object | What | Behaviours |
| --- | --- | --- |
| `courses.theme` | Name, slug, order, short description, picture | `public` (every live one) |
| `courses.course` | Title, slug, theme, level, summary, description (`richText`), cover (`image`), trailer (`video`), price, **outline** (document) | `publishable` (all content fields) with `public`; `sellable` (grants an enrolment; a tax code); access (holders' parts of the outline) |
| `courses.bundle` | Title, slug, description, cover, its courses (refs in a document, two to ten **guess**), price | `publishable` with `public`; `sellable` (grants an enrolment of the bundle; a tax code) |
| `courses.enrolment` | Its Person, its course or bundle, its order, where it came from (`purchase`, `staff`, `import`), from and until, completed (for an imported completion) | `states` (`active`, `ended`, `void`); `customer: person`; `customerVia` the course and the bundle |
| `courses.progress` | Its Person, course, lesson key, state (`started`, `done`), when started and done, position in seconds, where it came from (`self`, `import`) | `customer: person`; written by the tools with `my.create` and `my.update` |

### Tools (operations)
Tools are `x.courses.<tool>`. None holds a rule the host already holds.
- `catalogue { theme?, level? }` (public): published courses, bundles and themes with their prices
  and the deployment's currency, through `public.list`.
- `course { slug }` (public): one published course: its fields, the outline's public parts, and,
  for a signed-in customer, whether they hold access and their progress.
- `lesson { courseId, lessonKey }` (customer; staff): the lesson's holders' parts and, for a video,
  a playback token from `media.play`; the one not-found without access.
- `progress { courseId, lessonKey, state?, position? }` (customer): marks started or done, keeps
  the position; refused without access.
- `myCourses` (customer): every course the caller holds access to and why (bought, bundle,
  given, imported), with progress per course.
- `buy { courseId | bundleId, email? }` (customer, public): `order.start` for one line; the buyer
  then calls `order.checkout`. Refused, as the record that does not exist, for a course the caller
  already holds (**guess**: no buying twice).
- `enrol { personId, courseId | bundleId, until?, reason }` (staff, `write`, permission
  `courses:enrol`, grantable): access given by staff, with who and why on the record.
- `endEnrolment { enrolmentId, reason }` (staff): ends an enrolment staff gave or one imported. A
  bought one ends by refund, as every grant does.
- `stats { courseId? }` (staff, read): enrolments, completion and lessons done by week.
- `draft { brief }` (staff): the assistant's draft of a course's outline and lesson text as a
  working copy, built only from videos already in the library and programs already published; it
  never publishes.
- `startSession { courseId, lessonKey }` (customer): for a `session` lesson, the caller's
  `programs.session` for it once the assignment exists.

### Staff side, from the host
- Themes, courses, bundles, enrolments and progress in the admin with lists, record pages and
  saved views: "Published courses", "Drafts", "Enrolments this month", "Imported enrolments".
- The **media library** shows videos with their state, duration and captions, and uploads them.
- A **Courses** dashboard: revenue by month split by course and bundle (net of tax when tax is on),
  enrolments by course, completions, lessons done by week, students with nothing done in two
  weeks. Its numbers are checked against a fixture worked out by hand.
- A Person's page gets a **Courses** tab (enrolments and progress); orders already post to their
  timeline.

### Headless hooks and blocks
Hooks (`@composable-os/pack-courses/client`), generic over the client's operations (ADR 0453):
`useCatalogue`, `useCourse`, `useLesson`, `usePlayback` (asks again before the token expires),
`useProgress`, `useMyCourses`, `useBuy`, and for staff `useEnrol` and the course builder's pure
outline edits (`outlineEdits`, as Programs' `layoutEdits`).

| Block | Skin | What |
| --- | --- | --- |
| Catalogue | web, native | Courses by theme and level, and bundles. Web shows prices; **native shows no price and no buy button** |
| Course page | web, native | The description, trailer, outline with lesson titles and durations, free previews; buy on the web, "open" for a holder on both |
| Player | web, native | A lesson: video with captions and resume, rich text, a download, or the session (Programs' session block inside it); mark done; next lesson |
| My courses | web, native | What the caller holds, with progress, and continue where they left off |
| Course builder | web (staff) | Sections and lessons by drag and keyboard, videos and files picked from the library, rich text, sessions picked from published programs, preview flags, versions and publish |

The native blocks take the video player as a prop, so they depend on no device package
(**guess**: the app passes `expo-video` with the signed HLS address). No native block calls `buy`
or `order.checkout`; the block lint gains that check for blocks marked `noPurchase` (**guess** at
the mechanism), so "no buying in the app" is held by the lint, not by memory. Before the app ships,
the stores' current rules on apps that play content bought elsewhere are read again (stage 25's
note).

### AI
- The assistant may draft a course with `draft`, write a theme's text, and report with `stats` and
  the `rec_*` views. It never uploads a video (an upload is a person's).
- **Publishing a course follows whatever the platform's publish rule is.** Today `record.publish`
  is a person's with `records:publish`, never an AI actor (ADR 0446). The owner is deciding
  whether an AI may *ask* for a publish that a person then approves. This stage adds nothing to
  that rule and depends on neither answer: a course and a bundle are published through
  `record.publish` like any publishable record.
- Refunds and giving access are as the platform already has them: an AI may propose, a person
  with the permission approves.

## Video: why Stream, and its cost
Stream holds who may watch in a short-lived token the host signs for a holder only, so a leaked
page source or a shared link stops working within the hour, and every phone gets adaptive
playback. At list prices (check at build) it is $5 a month per 1,000 minutes stored and $1 per
1,000 minutes delivered, with encoding and bandwidth free. A worked example, **(guess)** at the
numbers: 60 hours of lessons stored is 3,600 minutes, about $18 a month; 300 students watching 3
hours a month is 54,000 minutes, about $54. The bill grows with how much people watch. Stream's
documentation names no DRM, so offline, when it is added, keeps a downloaded file only as safe as
the app's own storage.

## Selling: what is reused as built
- **One course and one bundle are ordinary sellable records.** `order.start`, guest checkout,
  `order.checkout`, the verified webhook, the confirmation email, refunds through approval and the
  `void` on a full refund all work as built. The grant is one `courses.enrolment`.
- **A bundle** grants one enrolment that points at the bundle, and access reaches its courses
  through it (source 2).
- **Deposits and most per order** are not used by courses. A sale window is available for a launch
  date.
- **Tax** is section 4 above.
- **Buying is on the web only.**

## Migration from a hosted course platform

Follow the shape of `cos content import` (ADR 0470): a folder in the platform's own shapes, checked
whole before signing in, a dry run on the host, import keys so a second run changes only what the
source changed, a person's edit never overwritten, and publishing as the person's own choice.

### What moves, and how
- **Courses and their outlines:** `cos courses import <folder>`. One JSON file per course in the
  platform's shapes (the outline document, rich text as `RICH_TEXT_SCHEMA`), each lesson with its
  `sourceId`, a video named by `file` (in `videos/`) or `url` (an address Stream copies from),
  pictures and downloads by file name, themes and levels by name. The platform researched says
  "entire courses cannot be exported as a single file"; its API lists a course's sections and
  units, on its higher plans only, and may not return the content itself. So the first client's
  converter writes the folder from that API or by hand, and the folder check lists what did not
  convert.
- **Videos:** uploaded to Stream once, found again by a hash or the source's id, so a re-run
  uploads nothing. No export of original video files was found (**guess: there is none**), so the
  originals come from the studio's own files, or from a connected Vimeo or Wistia account, by
  Stream's copy from a link.
- **People:** the CSV import of people (`import.csv.*`, ADR 0102) with its "same email" match. No
  customer account and no password moves: a student signs in with their email by code and finds
  their courses. No mail is sent by the import.
- **Access:** `access.csv` (email, course or bundle key, from, until, where it came from) becomes
  `courses.enrolment` records with source `import`, through `record.import` with import keys. They
  are not orders: no order is invented for money taken elsewhere. Only one-off and bundle access
  moves in this stage (see "Today's subscribers", below).
- **Completed courses:** a `completed` column in `access.csv` marks the enrolment completed, so the
  course shows as done whatever the lesson rows say.
- **Lesson-by-lesson progress, when the export has it** (decided): `progress.csv` (email, course
  key, the lesson's `sourceId`, state, when done, position if given) becomes `courses.progress`
  rows with source `import`, matched to lessons by `sourceId`, with import keys. The platform
  researched exports progress per course as a report (middle plans) and per user and unit through
  its API (higher plans); the build reads a real export before promising either.
  - **When the export has no per-lesson progress:** completed courses are imported as completed
    (above), every other course starts at its first lesson, and the import's report says which
    courses had no progress to bring.
  - **When some rows cannot be matched** (a lesson the new outline dropped, an unknown person):
    they are listed in the report with their file and line, never dropped silently and never
    guessed; the rest imports.
  - **Imported progress never overwrites a student's own:** a row the student has since changed is
    a conflict, as a person's edit is (ADR 0470).
- **Purchase history** stays in the provider's export, not imported as orders.

### Today's subscribers (decided 2026-11-23)
Subscriptions are stage 32's, so **between stage 42 going live and stage 32 the new site has no
subscription**. The owner decided: **today's subscribers stay on the hosted platform until stage
32 is built, and the hosted school takes no new subscribers once the new site opens.** New buyers
are pointed at single courses and bundles on the new site (**guess** at the wording), so the group
that moves at stage 32 only shrinks. At stage 32 each subscribes again, free until the date they
have paid up to, and the hosted school then closes.

What that means for the first client (build step 9):
- **Two places run until stage 32:** the new site for everyone who bought one course or a bundle
  (imported or new), and the hosted school for its subscribers. A person who is both sees their
  one-off courses on the new site and keeps their subscription on the old one.
- **The videos are in both:** in Stream for the new site, and still on the old host for the
  subscribers, so storage is paid twice, and a lesson changed on one is changed by hand on the
  other, until stage 32.
- **The hosted school's subscription is closed to new sign-ups** on the day the new site opens;
  existing subscribers keep it and may cancel as usual.
- The cut-over below happens in two parts: one-off and bundle students at launch, subscribers at
  stage 32.

### A period where both run
- The new catalogue opens to new buyers on a set day; the hosted school keeps serving everyone who
  is there until a cut-over date (for subscribers, stage 32: see above).
- Imported access is in place before the first email to students; the email tells them to sign in
  with the same address.
- After the last cut-over (stage 32's), the hosted school's addresses point to the new catalogue,
  and its videos are removed from the old host.

### What to ask the current provider (and the storefront's owner)
- Whose Stripe account takes the school's payments and holds its subscriptions (for stage 32's
  move and for when the old subscriptions end).
- An export of users (name, email, sign-up date, tags), of enrolments per course with their dates,
  expiry and completion, and of transactions.
- Lesson-level progress per user and learning activity, from an export or the API, with the
  activity ids that the course structure uses.
- The original video files, or confirmation that the studio holds them; captions.
- Whether the course structure (sections, learning activities, their order and text) can be
  exported, or must be read from the API or copied.
- The notice period and the date the school's plan renews, which sets the cut-over.

## What the first client's setup would then be
- The Courses pack and Programs on in the studio's product, Content already on.
- Its themes and levels, its courses with videos in Stream, two or three fixed bundles, all
  published by a person.
- Tax turned on, for courses, bundles and ticket types, after the company has turned on Stripe
  Tax and added its registrations in its own Stripe account (for online sales, and for each place
  it holds events). Ticket prices shown stay what the buyer pays.
- The catalogue, course page and my-courses blocks on the studio's web app; the catalogue (no
  prices), course page, my courses and player in its app, signing in through the host as tickets
  already do.
- Its students, their one-off and bundle access, their completions and, where the export has it,
  their lesson progress imported. Its subscribers stay on the hosted school, closed to new
  sign-ups, until stage 32.

## Out of scope
- **Subscriptions, trials and per-period orders** (stage 32, with the decisions recorded above).
- Quizzes, assignments, SCORM, interactive video, live classes inside a course.
- Certificates of completion.
- Discussions, comments and community.
- Coupons, discounts and gift purchases (stage 34); "pick any three" bundles (stage 32's
  `allowance`).
- Drip and lessons unlocked in order.
- Offline viewing in the app (designed in, not built).
- Buying inside the app, through a store or a link out.
- More than one language; DRM.
- Tax-exclusive prices; a tax code per record rather than per object (unless the first client's
  events need it); invoices (stage 35).

## Acceptance criteria
1. **Pack on the contract:** Courses is built only on the public contract and the typed client,
   passes `cos ext check` and `cos ext test`, and a product without it has none of its objects.
2. **Video upload:** a staff person uploads a video through a direct upload address; the media
   item is ready only once Stream says so; a record naming a video that is not ready is refused;
   an MCP client, the assistant and an automation cannot ask for an upload.
3. **Signed playback:** a holder gets a token that plays; it stops working after its expiry; a
   customer without access, the public and a made-up id get the one not-found; a video id with no
   token does not play (checked against Stream in a by-hand run with a runbook); a public trailer
   plays for anyone; no token allows a download.
4. **Access, one-off:** against the fake provider, buying a course grants one enrolment in the
   paid batch; the buyer then reads the outline's holders' parts and plays its videos; a full
   refund voids the enrolment in the refund's batch and the next `lesson` read is not-found; an
   enrolment past its `until` gives no access.
5. **Access, bundle:** buying a bundle gives access to each of its courses and to no other; a
   course added to the bundle afterwards is readable by the earlier buyer (the stated default).
6. **The seam takes a third source:** a fixture source of another kind, declared in a test only,
   gives access with no change to the seam's code or `media.play`.
7. **The rule is the host's:** the stage 22 isolation test covers enrolments and progress; a
   customer's `my.get` of a course without access returns no holders' part; the block lint passes
   for every block, no block decides access, and no native block calls `buy` or `order.checkout`.
8. **Progress:** marking a lesson done, resuming a video at its position, and completing a course
   work; progress survives a new published version that keeps the lesson's key.
9. **Session lessons:** a holder's first open of a course with session lessons assigns its
   programs from that day; the lesson opens their own Programs session, and they log sets with
   Programs' own tools; a person without access gets no assignment and cannot log.
10. **Import:** `cos courses import` of a fixture folder (two courses, a bundle, five people,
    their access, one completed course, per-lesson progress for some lessons with one row that
    matches no lesson, three videos by file and by address) imports as drafts in one
    dry-run-checked run; the unmatched row is reported with its file and line and the rest is
    imported; a second run changes and uploads nothing; a person's edit and a student's own
    progress since are conflicts and kept; a folder with no progress file imports completions only
    and says so; imported students sign in by code and see their courses and progress; nothing was
    mailed.
11. **Tax, on:** with tax on and a course declaring a tax code, against the fake provider, the
    checkout asks for automatic tax, inclusive, with the billing address required; the verified
    payment's tax amount is stored on the order and its line, the order's total is the price, and
    the payment matches; a refund records as before.
12. **Tax, off:** with the setting off, or for an object with no tax code (the box office
    fixture's ticket type), the checkout is exactly as before stage 42, byte for byte in the fake
    provider's request; only a human admin can change the setting or a code.
12a. **Tax on tickets:** a Ticketing ticket type declares `txcd_50010001` by default; with tax on,
    buying two ticket types sends each line's code, inclusive, and the event's place when the
    provider takes one; the order's tax is stored per payment and in total, its total is the
    ticket prices, and the payment matches; places are held and confirmed, tickets granted and
    checked in exactly as without tax (stage 26 and 27 tests pass unchanged).
12b. **Tax on a deposit order:** a ticket type with a deposit is bought by deposit and the balance
    paid in two parts; each of the three payments carries the provider's tax on its own amount,
    and the order's tax is their sum; the order is paid with the same amount owed as without tax.
12c. **Refund of a part-paid order:** cancelled by staff, its tickets are voided and places
    released as built; each payment is then refunded as its own action, and each refund records
    the tax returned for that payment.
13. **Tax, by hand:** in Stripe's test mode with a test registration, a course bought from an
    address in the registered place is charged tax inside the price and one from elsewhere none;
    a ticket for an event in the registered place is taxed by the event's place if the provider
    takes it (or the build's stop for a decision is recorded); the runbook lists what the company
    sets up in its own account.
14. **AI:** over MCP, the assistant drafts a course from a brief with only library videos and
    published programs; it cannot publish it directly; under whatever publish rule the platform
    then has, the course becomes public only after a person's act.
15. **Dashboard:** the Courses dashboard's numbers, net of tax, match a fixture worked out by
    hand.
16. `pnpm lint typecheck test` and one e2e test per journey (a visitor buys a course and watches a
    lesson; staff build and publish a course) pass in CI. ADRs, `CONTEXT.md` (Course, Lesson,
    Enrolment, Access, Bundle, Progress, Video; Order and Deposit amended for tax) and
    `docs/architecture.md` are updated. A list of what this stage changed in the Ticketing pack is
    in the PR.

## Dependencies
- Stages 25, 27 and 28 (merged) and 41 (steps 1 to 6 merged).
- Stage 32 adds subscriptions as a third access source on what this stage builds, with the
  decisions recorded above.
- A Cloudflare Stream subscription on the deployment's account (a person sets it up; `cos deploy`
  checks it, **guess**).
- For tax: Stripe Tax turned on, and registrations added, in the company's own Stripe account
  (the company's to do).

## Migrations and numbers
Migrations 0510 to 0519 (video and file media; tax amounts on orders and lines, and the order
setting; the access scope's tables if it needs any; the pack's tables come from the reconciler).
ADRs 0475 to 0479. Claimed in [`parallel-work.md`](../parallel-work.md) as block AE.

## Suggested build order
1. **Tax at checkout first**, as its own PR: the setting, `sellable.tax` and the code overrides in
   `gatekeeper-payments` and orders, the Ticketing pack's default code and its confirmation's tax
   line, deposits and part-paid refunds, against the fake provider; then the event's place in
   Stripe Tax and Stripe's test mode by hand, with the runbook. It needs nothing else in this
   stage, it touches the Ticketing pack, and tickets are what the first client sells now, so it
   goes before the video work rather than after.
2. Video media in Stream: direct upload, the ready state, the `video` field, captions; the `file`
   kind.
3. Signed playback (`media.play`) on the existing picture rule.
4. The access scope at the seam, with enrolments and bundles as its sources and the third-source
   test, and the holders' node flag on the document field; the isolation test.
5. *Precondition:* two of the client's real programs read against the outline. Then the pack's
   objects (declaring their tax code), the outline schema, `buy`, `lesson`, `progress`,
   `myCourses`; the buy, refund and bundle tests.
6. Session lessons on Programs.
7. The dashboard, views, the Person tab; hooks; web blocks, then native blocks; the course
   builder.
8. The assistant's draft; `cos courses import` with access, completions and progress.
9. The first client: its courses imported, its students, access and progress; the new site opens
   and the hosted school stops taking subscribers; two places run until stage 32.

Step 1 can run in parallel with steps 2 to 4: it is orders and the gatekeeper, they are media and
the seam. Steps 2 to 4 are the spine of courses: video that only a holder can play, and the one
rule that says who is a holder.

## Build step 1, tax at checkout, as built (2026-11-22)
ADR 0479, migration 0516. Where the build read the spec one way, or decided what it left open:

- **Stripe Tax can take an event's place at Checkout** (read 2026-11-22): a tax location of type
  `performance` (`POST /v1/tax/locations`) passed as
  `line_items[].price_data.product_data.tax_details.performance_location`, from API version
  `2026-09-30.endive`. `txcd_50010001` requires one. So a Ticketing event has a tax address
  (`taxCountry`, `taxRegion`, `taxPostcode`, `taxCity`, `taxAddress`) and the ticket type declares
  `txcd_50010001` with it; an event with no country for tax cannot be sold while tax is on.
- **Each payment's tax is on `core_order_payment`** (the verified payment), not on
  `core_order_checkout`, which keeps what was asked (`tax_lines`): a checkout may never be paid.
- **A payment is split over the lines in proportion to their totals**, so each share has its
  code; a deposit's share is in proportion too, not each line's own deposit.
- **A refund's tax is not known with Stripe:** its Refund object has no tax field (the guess at
  the field is answered: there is none). The host records a refund's tax only when the provider's
  event says it, so criterion 12c's "each refund records the tax returned" is not met with
  Stripe, and the fake provider, behaving as Stripe does, reports none either. **Open for the
  owner:** how a refund's tax is to be known (Stripe's reports, or another Stripe API, read by
  hand in the runbook's check 17), since the host does not work it out.
- **An order mixing lines with a code and lines without one** cannot be paid while tax is on
  (Stripe would use the account's default code).
- **Settings → Orders → Tax at checkout**: the switch, each object's code, and the warning that
  nothing is charged without registrations.
- Not run: Stripe in test mode (criterion 13, the runbook's part 8).

## Build steps 1 to 3 (the spine) and 4, 6, 7 and the draft (the pack), as built (2026-11-22)
ADRs 0475 to 0478, migration 0510. Where the build read the spec one way, or decided what it left
open (the ADRs have the rest):

- **Stream is reached by the host's own REST calls**, not a gatekeeper and not the Workers
  binding (no tus upload, no token expiry); the signing key is cos-app's alone. A pack tool never
  signs: `lesson` names the video and where it is shown, and the app asks `media.play`.
- **Whole fields for holders only are not built**; holders' parts of a document are. **No Stream
  webhook** yet: staff ask (`media.videoRefresh`). **The poster frame** is Stream's, with the token.
- **A bundle's courses are read from its published version**: a course added to a bundle reaches
  earlier buyers once a person publishes the bundle.
- **Courses requires Programs** as a declared `requires` the install checks. **Progress needs
  access** (`customer.requireAccess`): the host refuses a student's progress without it, so no
  session program is assigned to someone without access.
- **The app gets no price and no buy button**: every native block is `noPurchase`, held by the
  block lint.
- **A course and a bundle declare `txcd_20060158`** (on-demand online courses, no place).
  The dashboard's revenue is what buyers paid; net of tax reads ADR 0479's columns (not yet done).
- **Not built here:** `cos courses import` (step 8's import), the first client (step 9).

### Before the first client's import: check the outline against two real programs
The precondition of step 4 (two of the client's real programs read against the outline) could not
be met from the build; the outline follows the owner's answer (lessons, each a video and some
text, sometimes a training session to follow). Before the import is written, read two real
programs from the hosted platform and check, for each:
1. Every lesson is one of video, text, session or download, and nothing else the studio needs
   (a quiz, an assignment, a live class) is in them; anything else is listed and decided.
2. A lesson's video and its text fit one `video` lesson (a video and notes), or the text needs a
   lesson of its own.
3. A training session to follow maps to one Programs program and one session of it (a week and a
   position); a session that spans several, or a program not yet in Programs, is listed.
4. Sections are one level deep (the outline has no sub-sections).
5. The old platform's ids of lessons are stable and unique, to be each lesson's `sourceId` and to
   match the progress export by.
6. Which lessons are free previews, and that "every lesson open from the first day" holds (no
   drip, no order) for these programs.
7. Each video's source (the studio's file, or a Vimeo or Wistia link Stream can copy from) and
   its captions (WebVTT, or `.srt` to convert).
8. Durations are known (minutes), and no lesson's video is over 6 hours (the upload's limit).

## Still open
- **Whether Stripe Tax can take an event's place at Checkout**: answered in build step 1, yes
  (above).
- **How a refund's tax is known with Stripe** (above): the owner's decision.
- **Whether an AI may ask for a publish** is the platform's open question, not this stage's; this
  spec fits either answer.

## Sources
Read 2026-11-22 and 2026-11-23. Some LearnWorlds facts come from the official help pages' search
summaries where the page body would not load; the API reference (learnworlds.dev) could not be
read.

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
  [securing videos](https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/),
  [pricing](https://developers.cloudflare.com/stream/pricing/),
  [captions](https://developers.cloudflare.com/stream/edit-videos/adding-captions/),
  [uploading](https://developers.cloudflare.com/stream/uploading-videos/),
  [upload by link](https://developers.cloudflare.com/stream/uploading-videos/upload-via-link/),
  [MP4 downloads](https://developers.cloudflare.com/stream/viewing-videos/download-videos/).
- Stripe, accounts and subscriptions (for stage 32's move):
  [copying customers and cards between accounts](https://docs.stripe.com/get-started/data-migrations/pan-copy-self-serve),
  [migrating subscriptions](https://docs.stripe.com/billing/subscriptions/migrate-subscriptions),
  [billing migration toolkit](https://docs.stripe.com/billing/subscriptions/import-subscriptions-toolkit),
  [subscriptions with Connect](https://docs.stripe.com/connect/subscriptions).
- Stripe Tax:
  [tax on the Checkout page](https://docs.stripe.com/tax/checkout/page) (registrations, automatic
  tax, the address it uses, `total_details.amount_tax`),
  [product tax codes](https://docs.stripe.com/tax/tax-codes) (`txcd_20060158`, `txcd_50010001`
  and the other admission codes, read 2026-11-23),
  [tax codes and tax behaviour](https://docs.stripe.com/tax/products-prices-tax-codes-tax-behavior)
  (inclusive keeps the amount the buyer pays; behaviour cannot change once set),
  [tax reporting](https://docs.stripe.com/tax/reports) (a refund of a Checkout charge reduces the
  tax reported), [pricing](https://stripe.com/tax/pricing).

Not found in a primary source, and marked as guesses above: whether LearnWorlds exports original
video files; its users CSV's columns; its exact API paths and whether the API returns lesson
content; the shape of its per-lesson progress export; the price of Stream's generated captions;
how Stream counts MP4 downloads; the field a Stripe refund event carries the refunded tax in; and
the app stores' current rules for the first client's countries.
