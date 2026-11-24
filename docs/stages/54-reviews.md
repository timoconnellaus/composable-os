# Stage 54: Reviews

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (the
visibility seam, Behaviours, Content), [`CONTEXT.md`](../../CONTEXT.md) (Publish, Public scope,
Customer, Routine mail, Minor, Pack role, Permission grant), ADRs
[0401](../adr/0401-platform-packs-screens.md), [0402](../adr/0402-staff-and-customers.md),
[0404](../adr/0404-behaviours-are-the-vocabulary.md), [0414](../adr/0414-pack-tools-run-as-the-customer.md),
[0428](../adr/0428-buying-without-an-account.md) (the public's first writes, a token kept as a
hash), [0438](../adr/0438-the-public-scope.md), [0441](../adr/0441-publishable-states-schedules-and-versions.md),
[0442](../adr/0442-what-the-public-reads-of-content.md), [0446](../adr/0446-publishable-without-its-public-half.md),
[0449](../adr/0449-permissions-granted-one-by-one.md), [0480](../adr/0480-an-ai-asks-to-publish-a-person-approves.md),
[0540](../adr/0540-the-family-link.md), [0552](../adr/0552-a-tool-a-person-approves.md),
[0590](../adr/0590-routine-mail.md), [0625](../adr/0625-restricted-pack-permissions.md) and
[0643](../adr/0643-health-answers-read-by-a-person-with-the-permission-every-read-audited.md)
(data kept out of every bulk path, read by a person with a permission, every read audited); stage
specs [28](28-content.md), [31](31-bookings.md), [44](44-agreements.md) (the minor mark),
[47](47-pack-screens.md) (staff screens) and 48, My account (PR #311); stage 29, Forms, and stage
30, Notifications, both being specced beside this one.

Status: **spec agreed** (2026-11-24: every question was decided as best practice by the
coordinator, recorded below; no interview was needed and none is open). Builds after stage 29's
public-write door and personal links, and after stage 30's preferences and one-tap stop. Number
54.

Built so far (see "Built" at the end): step 1 (P1, publishable with an author), step 2 (P2,
restricted fields), step 3 (P3, `onlyWith` automations).

## Goal

A business asks the right people for a review at the right moment (a member after their tenth
class; for a trade, a customer a few days after a job), by an email with a personal link or an
item in the app's "Needs your attention". The person gives a star rating and a few words on the
business's own site or app, says whether the business may show it publicly under a name they
choose (their first name by default), and is thanked. Someone unhappy is offered a private "tell
us what went wrong" that only the people the business chose can read. Everyone is then shown the
public review sites the business listed. Nothing is shown until a person the business trusts
approves it, as written; then it appears in a reviews block on the business's website and in its
app. The person can withdraw their consent at any time and the quote disappears at once.

## Who it is for

- **Gyms and studios first.** The moment is attendance: a member's Nth attended class (the coach's
  tick, stage 31). A review says what it is about by class type ("Strength"). Members are signed
  in, so the app shows the ask in "Needs your attention" as well as by email. Children are never
  asked (decision 6).
- **Trades and services next.** No timetable and usually no customer account: the moment is a job
  finished or paid. Until Jobs (stage 39) and Invoices (stage 35) exist, staff ask by hand from a
  Person or a list; those stages add their own moment. Their reviews name the service ("Bathroom
  refit"). The public review links matter more to them than a wall of quotes.
- The same for both: one ask per person within a cool-down, a personal link with no account, the
  rating, the words, consent, approval by a person, the block.

## What exists today (from the code, checked 2026-11-24)

| Piece | Where | What it gives this stage |
| --- | --- | --- |
| `publishable` (working copy, versions, publish by a person, unpublish) | `packages/core/src/records/publish.ts`, `packages/core/src/operations/record-versions.ts`, ADRs 0441, 0446 | Approval is publishing: a person with `records:publish` publishes a review's version; an AI may only ask (ADR 0480) |
| `records:publish` | `packages/core/src/principals.ts` (admins hold it; it is in `GRANTABLE_PERMISSIONS`) | Exactly "admins plus any staff member they choose" (decision 4): an admin grants it one by one (ADR 0449) |
| The public's view of published content | `packages/core/src/operations/content.ts` (`content.get`, `content.list`), `packages/core/src/visibility/public.ts`, ADR 0442 | The website reads only the current version, only declared fields |
| Public scope with `when` | `packages/sdk/src/manifest.ts` (`public`), ADR 0438 | A withdrawn review leaves the public's reads in the batch of the withdrawal |
| Customer records, `my.create` / `my.update`, customer moves | `packages/core/src/operations/my-write.ts`, `packages/sdk/src/states.ts` (`MOVERS`), ADR 0414 | A signed-in member writes and withdraws their own review |
| **A publishable object may not declare a customer** | `packages/sdk/src/manifest.ts` (`validateManifest`: "A publishable object declares no customer or customerVia") | A review is both the author's and published: P1 changes this |
| **A publishable object the public reads must name a slug** | same file ("A publishable object the public reads names its slug field") | A review has no address of its own: P1 changes this |
| No "publish only in these states" rule | `records/publish.ts` publishes whatever the working copy holds | A review without consent must never be publishable: P1 adds it |
| Restricted pack permissions | ADR 0625, `packages/core/src/pack-roles.ts` (`staffAuthority`) | Who reads private feedback: admins and by grant only (decision 5) |
| Data kept out of `rec_*` views | ADR 0643 (health answers in a core table, read only with `agreements:health`, every read audited) | The pattern for private feedback (P2) |
| The minor mark | `CONTEXT.md` (Minor), migration `0851_agreement_acceptances.sql`, `packages/core/src/visibility/guardians.ts` | Who is never asked (decision 6) |
| Routine mail | `packages/sdk/src/routine-mail.ts`, `packages/core/src/routine-mail/`, ADR 0590 | The ask and the thank-you: fixed words, the host picks the recipient. A link slot carries a record id only (`withId`); stage 29 adds the personal-link slot |
| Automations: `fieldChanged`, `dateRelative`, `manual` with `bulk` | `packages/sdk/src/automation.ts`, `packages/sdk/src/automation-check.ts` | "After the Nth attended class", the reminder and expiry, "Ask for a review" on a Person or a list |
| Attendance | `packs/bookings/index.ts` (states `attended`, `no_show`) | The gym's moment |
| `requires` is all or nothing | `packages/core/src/extensions/install.ts` | A Reviews pack that needs Bookings for one automation would need it for all: P3 |
| Notices and tasks | `notification.send` (`packages/core/src/operations/notification.ts`), `ctx.notify` in automations, `task.create` | Staff told of an unhappy answer, a follow-up task |
| Erase of extension rows and published versions | `packages/core/src/records/erase-stores.ts` (`queueEraseExtensions`, the `core_publish_version` scrub) | A person's reviews go when they are erased |
| **Public writes** | none but purchases (`packages/core/src/visibility/writes.ts`: "The public change nothing"; `packages/core/open-operations.json`) | Stage 29 opens the one door (below) |
| **An opt-out from a kind of email** | none in the code today | Stage 30 builds preferences and the one-tap stop (below) |

## Decided 2026-11-24 (as best practice, by the coordinator; no interview needed)

| # | Decision |
| --- | --- |
| 1 | **A member is asked without anyone doing it by hand after a set number of attended classes** (default the 10th). Not when an intro offer ends. Staff can still ask anyone by hand |
| 2 | **Everyone is shown the public review links after their answer.** An unhappy person is offered the private "what went wrong" first, then the links. Nobody is sent only to the public sites because they were happy |
| 3 | **Staff never correct, shorten or change a review.** It is shown as written or not at all |
| 4 | **Admins, plus any staff member they choose, approve a review** before it appears on the website |
| 5 | **Only the owner, admins and people they choose read the private "what went wrong" answers** (they may name a coach) |
| 6 | **A child is never asked, and nobody is asked about a child's classes** |
| 7 | **The cool-down between two asks of one person is 180 days** |
| 8 | **No average star rating on the website** by default; the business may turn it on later with its own words |
| 9 | **How the business asks today, and the trades' moment and review sites, were not asked**: the draft's assumptions stand, to be checked with the business during setup |

## The design in one page

- **One record, the review,** in a small **Reviews pack** (`packs/reviews`). It belongs to the
  Person who wrote it (its customer field). It holds the rating (1 to 5), the words, the name to
  show, what it is about (set by the ask), the consent and its wording, and whether they may be
  contacted. The private feedback is not a field of the record: it is kept by the host out of
  every bulk path (P2).
- **The ask** is a second record: who was asked, for what moment, about what, when, and its state.
  An ask is made only through the pack's `reviews.ask` tool, which refuses a minor, a Person within
  the cool-down or with a live ask, and a Person who turned review asks off (stage 30's
  preferences). The ask's personal link is stage 29's: one Person, one use, its token kept as a
  hash, sent through stage 29's personal-link slot in routine mail.
- **Answering needs no account.** The link opens the business's own answer page (a block). The
  answer goes in through stage 29's door (`intake.submit`) as the linked Person. A signed-in member
  answers in the app or on the site through the same door with no link. There is no open "leave a
  review" page anyone can fill in.
- **Consent is its own tick on the page,** unticked by default, its wording (the business's,
  versioned with the pack's settings) kept with the answer. No tick: the review is `private`, and
  the host refuses to publish it.
- **Unhappy answers** (at or below a threshold, default 3 stars) see "tell us what went wrong" and
  "may we contact you?" on the same page before they send; the words go to P2's restricted store,
  the holders of `reviews:feedback` are told (no words in the notice), and a follow-up task is
  made. After sending, **everyone** sees the public review links (decision 2).
- **Approval is publishing.** Nothing is public until a person with `records:publish` publishes the
  review (decision 4). Staff and every AI are refused any change to the author's fields (P1), so a
  published quote is always the author's (decision 3). Staff can unpublish at any time.
- **Showing** is a web block (`reviews-wall`) and a native twin over `reviews.list`, a public read
  of published, consented reviews, filterable by what they are about, newest first.
- **The person's own place is My account** (stage 48): a "Your reviews" section (change the name
  shown, change their mind about consent, withdraw) and the open ask as a "Needs your attention"
  item. No separate customer area.
- **Withdrawal:** from My account, or from the link in the thank-you email, the review moves to
  `withdrawn`, the host unpublishes it in the same batch and the public stops reading it.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **A review record and a testimonial record staff make from it** | A staff-made copy of a customer's words can drift from them, and keeping two records right on withdrawal and erase is a second set of rules. One record, published as written |
| **Building reviews on the Forms pack's form builder** | A review is a fixed set of fields with rules the host enforces (consent, the threshold, one answer per ask); a builder form can be edited into something else. It uses stage 29's door and personal links, not its builder |
| **An open public review form** | Anyone could post as anyone; approval would become spam control. Only invited people and signed-in customers write |
| **Staff fixing typos or trimming** | Decision 3: the quote is then not the person's |
| **Pulling reviews from, or posting to, public review sites** | An integration with outside services, their terms and a credential. Only plain links |
| **Sending only happy people to the public sites** | Decision 2. Some public review sites' own rules forbid it, and it is the familiar safe practice to show everyone |
| **An average star rating on the website by default** | Decision 8. An average of the reviews a business chose to show can mislead |
| **Private feedback as a field of the review** | It would be in the `rec_*` views, so in dashboards, exports, search and the assistant's reads, for every member (decision 5). Kept as ADR 0643 keeps health answers |
| **A separate `reviews:publish` permission for approving** | `record.publish` checks `records:publish` only, which is already admins plus whoever they grant it to (decision 4). A per-object publish permission would be a platform change for little gain; recorded as open to override |
| **A Reviews-own "don't ask me again" field** | Consent to be contacted and unsubscribing are owned by Notifications (stage 30); a second opt-out would disagree with the first |
| **A `reviews-bookings` companion pack for the gym moment** | A second pack to install for one automation. P3 lets one automation say it runs only with Bookings |
| **The app's own "how are we doing?" card computed in the client** | Stage 48: what needs the customer's attention is the host's answer, not a client's (ADR 0401) |

## Platform work and pack work

| # | Work | Kind | Notes |
| --- | --- | --- | --- |
| S29 | **From stage 29 (Forms), not built here:** the public-write door `intake.submit`, its abuse checks (Turnstile, honeypot, fill time, caps, link limits), personal links (one Person, one use, token kept as a hash, expiring) and the personal-link slot in routine mail. See "What this stage needs of Forms" | Platform (stage 29) | The reason this stage builds after Forms |
| S30 | **From stage 30 (Notifications), not built here:** optional routine message kinds, a Person's preferences, the one-tap stop in every optional email, and a host read "has this Person turned kind X off" | Platform (stage 30) | `reviews.ask` is an optional kind; stopping it is "don't ask me again" |
| P1 | **Publishable with an author.** A publishable object may declare `customer`: the author reads and writes their working copy through `customer.read` / `customer.write`; others outside read only the published version through `public`. **Author-only fields**: fields the customer writes on such an object are refused to staff and every AI (`record.update`, imports, bulk, MCP, the assistant); staff may still publish, unpublish and move states. **No slug**: a public publishable object may be listed only (`content.list`; `content.get` answers not found). **Publish only in listed states** (`publishable.publishIn`) | Platform (contract, seam, records) | Changes the two contract refusals named above. Touches `visibility/`. Needs a security review like stage 22's |
| P2 | **Restricted fields.** A text field may be declared `restricted: "<pack>:<word>"` naming a restricted permission of the pack (ADR 0625). The host keeps its value in a core table, in no `rec_*` view, search, export, embedding, summary or dashboard; the author writes it and reads their own; staff read it only through a restricted tool, a person only, every read audited | Platform (records, a migration) | ADR 0643's pattern made general. Forms' ratings "for owners and managers only" may use it too (overlap) |
| P3 | **An automation that runs only with another pack:** `onlyWith: ["bookings"]` on an automation; the pack installs without Bookings and the automation is skipped (and listed as off) until Bookings is installed and on | Platform (contract, install) | `packages/sdk` manifest and `automation-check.ts`, `packages/core/src/extensions/install.ts` |
| K1 | The Reviews pack: `reviews.ask`, `reviews.review`, states, settings, tools, views, dashboard, routine mail kinds, automations, the `portal` section | Pack | |
| K2 | Blocks: the answer page, the withdraw page, the wall, web and native skins over headless hooks; the My account section | Pack | Web and native share logic, not screens |
| K3 | A staff screen "Reviews" declared under stage 47 | Pack | |

### What this stage needs of Forms (stage 29)

Stated as requirements, in Forms' own words; Forms owns them and this stage does not redefine
them. Its draft already names each but the first.

1. **`intake` on an object that is not a Forms submission, with no form record.** The Reviews pack
   declares `intake` on `reviews.review` with its own fixed list of fields (rating, words, shown
   name, consent, contact me, the private feedback), checked by the object's declaration, not by a
   form's question schema. The door's abuse checks apply as for any form.
2. **Personal links for such an object:** made by a pack's tool for one Person, about one record
   (the ask), used once, expiring after the pack's days, refused a second time by the database; a
   used, expired, wrong or erased-person link gets one identical answer; the page shown by an open
   link names neither the Person nor their address.
3. **The personal-link slot in routine mail**, the token minted at send time and never stored in
   clear, never in the audit log or a logged URL.
4. **The same door for a signed-in customer** (certainty `account`), so the app needs no link.
5. **A "Needs your attention" item for a live personal link** (stage 48's later kind
   `form_to_fill`), so a signed-in member sees the ask in the app.

If stage 29's spec settles any of these differently, the build follows stage 29 and records the
change in its PR.

### What this stage needs of Notifications (stage 30)

The ask (`reviews.ask`) and its reminder are an **optional** routine message kind: every one
carries stage 30's one-tap stop, and the Person's preferences can turn it off. `reviews.ask`
(the tool) reads the host's "has this Person turned this kind off" before making an ask and refuses
with words if so, so an opted-out Person does not use up a cool-down. The thank-you (with the
withdraw link) is **essential**: it is sent once, to the person who just answered. Texts are not
used.

## The model

### Words (for `CONTEXT.md`)

**Review**: a Person's rating and words about the business, with their consent to show it.
**Review ask**: an invitation to one Person to review, with its moment. **Private feedback**: what
an unhappy reviewer told the business privately, read only with `reviews:feedback`.
_Avoid_: testimonial (one record only), rating (a Forms answer kind), feedback (alone: Forms'
submission kind).

### Records

**`reviews.ask`**: `person` (relation), `moment` (select: `by_hand`, `classes`; later `job`,
`invoice`), `about` (text, 60 characters, e.g. a class type's name), `askedBy` (user, empty for an
automation), `sentAt`, `answeredAt`, `state`. One live per Person (declared uniqueness over
`pending`, `sent`).

States: `pending` → `sent` (host, when the email is sent) → `answered` (host, by the door) |
`expired` (host, when the link expires, default 14 days) | `cancelled` (staff). One reminder
(default after 5 days; 0 turns it off) is a second email on the same ask, not a new ask.

**`reviews.review`** (`intake`, `publishable`, `customer`):
`person` (customer field), `ask` (relation, read-only, set by the host), `rating` (number 1 to 5,
required), `words` (text, at most 1,000 characters, no links), `shownName` (text, 40 characters,
default the Person's given name; the author may change it, e.g. "Sam L."), `about` (copied from
the ask, read-only), `consent` (select `yes` / `no`), `consentWording` (read-only, the words shown,
set by the host), `consentAt` (read-only), `contactMe` (boolean), `privateFeedback` (text, 2,000
characters, `restricted: "reviews:feedback"`, P2), `state`.

- `publishable`: content `rating`, `words`, `shownName`, `about`, `date`; no slug;
  `publishIn: ["consented"]` (P1).
- `public.read`: those fields and `publishedAt`; `when: { field: "state", in: ["consented"] }`.
- `customer`: the author reads all of it (their own private feedback included) and writes
  `rating`, `words`, `shownName`, `consent`, `contactMe`, `privateFeedback` while the review is
  `private` or `consented`. These are the author-only fields (P1).

States: `private` (no consent) or `consented`, chosen by the host from `consent` at the answer;
`private` ↔ `consented` by the author only; `private` or `consented` → `withdrawn` by the author,
or by a person on the staff recording the author's request with a reason (`reviews.withdrawFor`);
`withdrawn` is final, and entering it unpublishes in the same batch. A review is on the website
when it is `consented` **and** has a current version. An author's change to a published review
(a new shown name) changes the working copy only; the website keeps showing the approved version
until a person publishes again. Changing consent to `no` takes it off the website at once (the
`when`).

### Who is asked

`reviews.ask` refuses, with words saying why, a Person who:

- is a minor (`CONTEXT.md`, Minor: a dependant of a live family link, or marked a minor by staff;
  decision 6). A booking of a minor's never counts towards anyone's Nth class;
- has a live ask, or an ask sent within the cool-down (180 days, decision 7);
- has turned review asks off (stage 30), or has no usable email address;
- is erased.

### Settings (Settings → Extensions → Reviews)

Ask after the Nth attended class (default 10; 0 off), cool-down days (180, from 30 to 730), link
valid days (14), reminder after days (5; 0 off), unhappy at or below (3 stars), who gets the
follow-up task (a person holding `reviews:feedback`; default none, the task is unassigned), up to
three public review links (a label and an `https` address, each `personApproves`, so an AI's change
waits for a person), the consent wording (a default the business confirms with its lawyer), show an
average on the wall (off, with the business's own words when on).

### Operations and tools

| Name | Audience | Who may | Risk | What |
| --- | --- | --- | --- | --- |
| `reviews.ask` (tool) | staff | `reviews:ask` (members by default); an automation | write, `personApproves` for an AI | Ask one Person or a selection (`bulk`); refused with words as above; makes the ask and the personal link |
| `reviews.cancelAsk` (tool) | staff | `reviews:ask` | write | Cancels a live ask; the link stops working |
| `x.reviews.answer` (tool over `intake.submit`) | public with a personal link, customer | the linked Person, or the signed-in customer with a live ask | write | **Opens a write to the public: a reviewed change (ADR 0402).** Writes one review as the Person, once per ask |
| `reviews.page` (tool) | public with a personal link, customer | as above | read | What the answer page shows: what it is about, the consent wording, the threshold, the public links. Names no Person |
| `reviews.links` (tool) | public, customer | anyone | read | The public review links, shown after any answer (decision 2) |
| `reviews.withdraw` (tool) | customer; public with the review's withdraw link | the author | write | **Public write: reviewed change.** It can only withdraw, never write words; the link is a personal link of its own, from the thank-you email |
| `reviews.list` (tool over `content.list`) | public, customer, staff | anyone | read | Published, consented reviews, filter by `about`, newest first, at most 50 a page; the average only when the setting is on |
| `record.publish` / `record.unpublish` | staff | a person with `records:publish` (decision 4) | write | Approve and hide; an AI may only ask (ADR 0480); refused outside `consented` (P1) |
| `reviews.withdrawFor` (tool) | staff | `reviews:ask`, `actors: ["human"]` | write | Records a withdrawal asked for by phone or in person, with a reason, audited |
| `reviews.feedback` (tool) | staff | `reviews:feedback` (restricted, grantable, ADR 0625), `actors: ["human"]` | read | The private feedback of one review or a page of them; every read audited (decision 5) |

Customer operations are `mcp: { expose: false }` and rate limited per account; the public ones
carry stage 29's abuse checks.

### Automations (the pack's own, declared steps)

- **After the Nth class** (`onlyWith: ["bookings"]`, P3): `fieldChanged` on
  `bookings.booking.state` to `attended`; counts the Person's attended bookings through `ctx.ops`;
  at exactly N calls `reviews.ask` with `moment: "classes"` and `about` the class type.
- **Ask by hand:** `manual` on Person, with `bulk`.
- **Send, remind, expire:** on a new ask, the routine email `reviews.ask` with the personal link;
  `dateRelative` for the reminder and the expiry.
- **Unhappy answer:** on a review created at or below the threshold, an in-app notice to the
  holders of `reviews:feedback` and a task "Follow up a review" linked to the Person. Neither
  carries any words of the review or the feedback, and neither names a coach.
- **Reviews waiting:** a daily notice to holders of `records:publish` with the count of consented,
  unpublished reviews (none when zero).

### Screens

- **Customer web (blocks):** `reviews-answer` (stars, words, name to show, consent; the private
  fields when the rating is at or below the threshold; then the public links), `reviews-withdraw`,
  `reviews-wall` (the website's quotes, the average only when on).
- **Native:** `reviews-native-answer` (opened from the attention item), `reviews-native-wall`.
- **My account (stage 48):** a `portal` section "Your reviews" (`has: ["reviews.review"]`): each
  review with its state, change the name shown, change consent, withdraw. The open ask is the
  `form_to_fill` attention item (S29, item 5).
- **Staff (a stage 47 screen, "Reviews"):** waiting (consented, not published), shown, private
  (no consent), withdrawn; publish and unpublish; private feedback shown only to holders of
  `reviews:feedback`. Declared views; a small dashboard (asks sent, answered, the average of
  **all** answers, not only shown ones). A Person's record tab lists their asks and reviews.

### Notifications

The ask and its one reminder (optional routine mail, off until an admin turns the kind on, each
with stage 30's one-tap stop); the thank-you with the withdraw link (essential, routine mail);
staff in-app notices for an unhappy answer and the daily "reviews waiting" count. No email to staff
carries a review's words.

### What an AI may do

- Read reviews and their states (not private feedback), summarise themes for staff, draft a
  follow-up task.
- Propose asks: its call to `reviews.ask` waits for a person (`personApproves`), and routine mail
  holds anything an AI started (ADR 0590).
- Ask for a publish; a person with `records:publish` decides (ADR 0480).
- Never: write or change a review's rating, words, name or consent (P1); publish or withdraw;
  change the public links without a person; read private feedback, even for an account that holds
  `reviews:feedback` (the tool is `actors: ["human"]`); answer on anyone's behalf.

### Privacy and erase

- The public reads the published version's five fields and `publishedAt`, nothing else: never the
  Person, the ask, consent details or private feedback. The answer page never shows who was asked.
- Tokens are kept as hashes, never in the audit log, a logged URL or storage (stage 29).
- Consent is kept with its wording and time; a withdrawal is audited with who and why.
- Erasing a Person deletes their asks and reviews, their restricted values (P2) and scrubs their
  published versions (`erase-stores.ts`); the content generation moves so no cached answer still
  shows a quote.
- Merging moves asks and reviews to the surviving Person; the cool-down reads both.
- What a business may say about the reviews it shows, whether an ask is a marketing message, and
  how long it keeps reviews, are for the business to confirm with its lawyer.

## Out of scope

- Importing reviews from public review sites or another system; posting to them; replying in
  public.
- Reviews of a named coach or staff member (ratings of people need their own privacy decisions).
- Photos or video with a review; star ratings in search engines' structured data.
- Incentives for reviewing (discounts, entries): not built, and for the business's lawyer.
- The moments "a job done" and "an invoice paid": added by stages 39 and 35.
- Asks by text or push (stage 30's channels; a later change of the kind's declaration).
- The intro-offer moment (decision 1).

## Acceptance criteria

1. With Bookings and Reviews installed and N = 10, a member's tenth `attended` booking makes one
   ask; the eleventh does not; a member asked within 180 days is not asked again.
2. Reviews installs without Bookings; its "after the Nth class" automation is listed as off and
   runs once Bookings is installed and on.
3. A minor (a dependant of a live family link, or marked a minor) is never asked, by hand or by
   automation; the refusal says why; a minor's booking never counts towards an ask.
4. A Person who turned review asks off (stage 30) is refused with words and keeps no ask.
5. Staff ask one Person by hand and a selection of ten from a list: one email each with a personal
   link; an AI's ask waits for a person.
6. The link, opened with no account, shows the answer page without the Person's name or address;
   it answers once; a used, expired, cancelled, wrong or erased-person link gives one identical
   answer.
7. A 5-star answer with consent is `consented` and not on the website; after a person with
   `records:publish` publishes it, the website's block shows the rating, words, shown name and
   what it is about, and nothing else. A member without `records:publish` cannot publish; one
   granted it can.
8. An answer without consent is `private`; publishing it is refused; the public never reads it.
9. A 2-star answer is offered the private fields; its private feedback is in no `rec_*` view,
   search, export, dashboard or public read; the notice and the task carry no words; only a
   person holding `reviews:feedback` reads it, every read audited; an AI is refused.
10. Every answer, happy or not, is then shown the configured public links.
11. A staff `record.update` of `rating`, `words`, `shownName` or `consent` is refused on every path
    (record page, import, bulk, MCP, the assistant).
12. The author's withdrawal (My account or the email's link) removes the quote from `reviews.list`
    in the same batch, unpublishes it, and no cached answer serves it after.
13. Changing consent to "no" in My account takes a published review off the website at once; a
    changed shown name is not public until a person publishes again.
14. Erasing the Person removes their reviews from every public read, their versions' content and
    their restricted values.
15. `reviews.list` reads a bounded number of rows (a statement-count test); the answer's writes
    carry stage 29's abuse checks.
16. The website shows no average unless the setting is on.
17. `open-operations.json` lists the new public and customer operations; the audiences review
    signs them off.
18. `cos ext check packs/reviews` and `cos ext test packs/reviews` pass; every tool and automation
    has a test.
19. E2E: one journey (asked by email, answers, staff publish, shown on the site, withdrawn).
20. The site and `SITE.md` list Reviews as built once merged.

## Dependencies

- **Stage 29, Forms (being specced): hard.** The door, abuse checks, personal links and their mail
  slot (S29). Its steps 2 and 5 must be merged before step 4 here.
- **Stage 30, Notifications (being specced): hard for asks.** Optional kinds, preferences and the
  one-tap stop (S30), its step 3. Steps 1 to 3 here do not wait for it.
- **Stage 48, My account (PR #311):** the `portal` section and the attention item. The section
  waits for its `portal` declaration; until then the withdraw link works alone.
- **Stage 47, pack screens (spec agreed):** the staff screen; views work without it.
- **Built:** stage 28 (publishable, public reads, the cache), stage 31a (attendance, the family
  link), stage 44 (the minor mark), routine mail (ADR 0590), restricted permissions (ADR 0625).
- Later: stages 39 (Jobs) and 35 (Invoices) add their moments.

## Migrations and numbers

Block **BP**: migrations **1190 to 1209**, ADRs **0810 to 0819** (the coordinator records the
block in `docs/parallel-work.md`).

- Migration 1190: P2's restricted values table (a core table; its erase and audit), and whatever
  P1 needs in the host's publish guard. No `x_*` table is touched by a migration.
- ADR **0810**: publishable with an author (author-only fields, no slug, publish only in listed
  states); amends ADRs 0442 and 0446 with dated notes.
- ADR **0811**: restricted fields (generalises ADR 0643's pattern; relates ADR 0625).
- ADR **0812**: an automation that runs only with another pack (`onlyWith`).
- ADR **0813**: the Reviews pack (asks, who is asked, consent and withdrawal, approval as
  publishing, its public operations; amends ADR 0402 for them).

## Suggested build order

| Step | What | Files or areas | Beside, and what it collides with |
| --- | --- | --- | --- |
| 1 | P1: publishable with an author, author-only fields, no slug, `publishIn` | `packages/sdk/src/manifest.ts` (contract), `packages/core/src/visibility/`, `records/publish.ts`, `operations/content.ts`, `extensions/schema.ts` | Beside 2 and 3. **Collides** with anything in `visibility/` (stage 29's door, stage 48's `me.*` reads) and Content work; not beside stage 29 step 2 |
| 2 | P2: restricted fields, migration 1190, the audited read, erase | `packages/sdk` (field declaration), `packages/core/src/records/`, `erase-stores.ts`, `packages/db/migrations` | Beside 1 and 3. **Collides** with the erase-completeness area and any work that changes `rec_*` view building |
| 3 | P3: `onlyWith` automations | `packages/sdk` (manifest, `automation-check.ts`), `packages/core/src/extensions/install.ts` | Beside 1 and 2. **Collides** with stage 47 step 1 and stage 48's `portal` key (both in the manifest) |
| 4 | The Reviews pack's spine: objects, states, settings, tools, automations, views, routine mail kinds, tests | `packs/reviews/` (new) | Needs 1 to 3, stage 29 steps 2 and 5, stage 30 step 3. Beside any other pack |
| 5 | Blocks (web and native), headless hooks, the staff screen, the My account section | `packs/reviews/blocks`, `client/`, the pack's `screens` and `portal` | Beside other packs; after stage 47 step 1 and stage 48's `portal` declaration |
| 6 | E2E, erase and merge tests, the site and `SITE.md` | `apps/app/e2e`, `packages/core/test`, `apps/marketing` | **Collides** with other site edits |

Steps 1 to 3 can run at once, before stage 29 is built, as long as step 1 is not beside stage 29
step 2. Steps 4 to 6 are one session.

## Size

**Small to medium.** The pack is small; steps 1 and 2 touch the seam and the records layer and are
the real work.

## Decided by this spec, open to override

- One record per review; approval is the existing publish, by a person.
- Approving is `records:publish` (admins, plus whoever an admin grants it to), not a
  Reviews-own permission; it also lets them publish other publishable records.
- Private feedback is a restricted field held out of every bulk path, read with a restricted,
  grantable `reviews:feedback`, a person only, every read audited.
- The private fields are on the same answer page, shown when the rating is at or below the
  threshold; one write, not a second step.
- No open public review form; invited people and signed-in customers only.
- Consent unticked by default, its wording kept with the answer; withdrawal at any time; a
  withdrawal unpublishes.
- The author's later change to the shown name waits for a new publish; a change of consent to "no"
  takes effect at once.
- First name by default as the shown name; the author may change it.
- 1 to 5 stars; unhappy at 3 or below.
- One live ask per Person, one reminder after 5 days, links valid 14 days.
- Minors are never asked, by the existing minor rule (stage 44).
- "Don't ask me again" is stage 30's stop on the optional `reviews.ask` kind; the tool refuses an
  opted-out Person so no cool-down is used up.
- The ask in the app is stage 48's `form_to_fill` attention item; the person's reviews are a
  section of My account.
- The gym moment is one automation with `onlyWith: ["bookings"]`, not a companion pack.
- The follow-up task is unassigned unless an admin names someone.

## Questions for the owner

None. Every point was decided as best practice (above); the business's current way of asking and
the trades' moment and review sites are to be checked with each business during setup.

## Risks

- **Seam change (P1, P2):** a customer-owned record read by the public through versions is new;
  a mistake shows a working copy or private feedback. Needs a security review like stage 22's.
- **Fake or abusive answers:** a forwarded link lets someone else answer as the Person; one use,
  stage 29's abuse checks and approval by a person contain it, not prevent it.
- **Privacy:** words can name staff or other members; approval must catch it. A shown name can be
  identifying in a small town.
- **Email:** whether a review ask is routine mail or marketing is for the business to confirm with
  its lawyer; the kind is off until an admin turns it on.
- **Money:** none.
- **Needs a real client:** the Nth class and the wording; the website block with real quotes; the
  bot check on a real site; routine mail on a real email connection.

## Built

- **Step 1 (P1), 2026-11-24.** [ADR 0810](../adr/0810-publishable-with-an-author.md) (amends 0442
  and 0446). No migration: P1 needs no table (1190 stays P2's; 1191 to 1194, given to this step,
  are unused). A publishable object may declare a `customer`, its author, beside `public`; it has
  no slug and is listed only (`content.list`; `content.get` not found); `public.read` never lists
  the author; read-only fields may be content. The author's fields (`customer.write` but the state
  field) are refused, `forbidden` / `author_only`, to every staff-side caller in the record code
  every write goes through (`records/authored.ts`, called from `prepareValues`), and shown
  read-only in `schema.objects`. `publishable.publishIn` (`packages/sdk` contract, manifest checks,
  the test host): a publish or schedule outside the states is refused, a due schedule dropped, and
  a write that moves the record out unpublishes it in its batch (`records/publish.ts`). Tests:
  `packages/core/test/publishable-author.test.ts`. Deviation: consent taken back unpublishes too
  (not only `when`), so consenting again waits for a person's publish (ADR 0810, Consequences).
- **Step 2, P2: restricted fields** (`feat/stage-54-restricted-fields`, migration 1190, ADR 0811):
  built. A pack's `text` or `longText` field may declare `restricted: "<pack>:<word>"` (one of its
  restricted permissions) on an object whose customer reads and writes it; the contract refuses
  any other use of it (`packages/sdk/src/restricted-fields.ts`). The host keeps the value in
  `core_restricted_value`, never in the `x_*` table, the registry or any view; the customer writes
  it and reads their own through the seam (`my.create`, `my.update`, `my.get`, `my.list`); staff
  read it only with `record.readRestricted`, from the declaring pack's `humanOnly` tool naming the
  permission, called by a person, every read audited without values; no audit row holds a value;
  erase and purge delete the author's values and scrub others that name them; dropping the field
  drops them. Proof: `packages/core/test/restricted-fields.test.ts`. Left for step 4: Reviews'
  `privateFeedback` and its `reviews.feedback` tool; stage 29's door writes through the same seam.
- **Step 3 (P3), 2026-11-24.** [ADR 0812](../adr/0812-an-automation-that-runs-only-with-another-pack.md).
  No migration (nothing is stored for the wait; 1190 stays P2's). `onlyWith: ["<extension>"]` on
  `defineAutomation` (`packages/sdk`: the contract, its manifest form, `automation-check.ts`): the
  extension installs without them, and while one is not installed that automation's trigger,
  step objects and the extension's `permissions.read` / `write` may name its objects; once it is,
  they are checked as usual. `cos ext check` installs the named packs from beside it first. The
  host reads `waitingFor` (`automations/registry.ts`, one read of `core_extensions` by id, only
  when a matched automation names one) on every path that starts a run: trigger matching and the
  cron, `automation.run`, runs held back by the rate rail. `automation.list` / `.get` show status
  `waiting` and `waitingFor`, and the automations screens say what it waits for. Tests:
  `apps/runner/test/automations-only-with.test.ts` (installs without the other, waits, runs once it
  is installed, waits again while it is disabled, the extra read), `packages/sdk/test/automation.test.ts`,
  `packages/extension-check/test/check.test.ts` (fixture `onlywith/`). Not done: field checks of
  another extension's object, which a deployment's check does not make today (ADR 0812,
  Consequences).
