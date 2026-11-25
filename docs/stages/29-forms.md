# Stage 29: Forms

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Audiences
and customers, the HTTP surface, Behaviours, routine mail), [`CONTEXT.md`](../../CONTEXT.md), ADRs
[0402](../adr/0402-staff-and-customers.md), [0412](../adr/0412-customer-scope-and-principals-as-built.md)
to [0414](../adr/0414-pack-tools-run-as-the-customer.md), [0428](../adr/0428-buying-without-an-account.md)
(buying without an account, `recordHostChange`), [0436](../adr/0436-pack-roles-and-the-door-role.md),
[0438](../adr/0438-the-public-scope.md), [0440](../adr/0440-rich-text-is-data.md),
[0444](../adr/0444-media-the-editor-and-the-content-pack.md), [0445](../adr/0445-the-document-field.md),
[0446](../adr/0446-publishable-without-its-public-half.md),
[0480](../adr/0480-an-ai-asks-to-publish-a-person-approves.md),
[0552](../adr/0552-a-tool-a-person-approves.md), [0590](../adr/0590-routine-mail.md),
[0625](../adr/0625-restricted-pack-permissions.md); stages [15](15-leads.md),
[44](44-agreements.md) and [47](47-pack-screens.md), and stage 48 (My account, spec on PR #311:
anything a customer sees of a module is a section or an attention kind there); issues
[#97](https://github.com/timoconnellaus/composable-os/issues/97) (this stage) and
[#117](https://github.com/timoconnellaus/composable-os/issues/117) (file upload from client apps).

Status: **spec agreed** (2026-11-24: decisions 1 to 10 decided by the coordinator under the owner's
standing rule that best-practice answers are decided, not asked; the owner may override any of
them). Roadmap stage 29, issue #97. Every step may start in the order below; nothing waits for an
interview.

## Status

- **Step 1** — built — PR #332 — The question schema and answer checking
  (`packages/sdk/src/questions.ts`: `QUESTIONS_SCHEMA`, `ANSWERS_SCHEMA`, `checkQuestions`,
  `checkAnswers`). No ADR, no migration.

- **Step 2** — built — PR #376 — `intake` and `intake.submit` (`feat/stage-29-intake`): the
  `intake` behaviour in three roles (form, submission,
  destination; `packages/sdk/src/intake.ts`), refused in a runtime extension; `checkQuestions` on
  every write of a form; `intake.open` and `intake.submit` (`toolOnly`, `hostInternal`, open to
  staff, customers and the public, reached only from the form's own pack's tool), in
  `open-operations.json`; the submitter's Person by the address matcher now shared with
  `resolveBuyer` (`customers/address-person.ts`), certainty `account`, `staff` or `address`, empty
  fields only; a destination record; staff told; anonymous submissions with the call forgetting
  the customer (`ctx.anonymise`); Turnstile with cos-runner's env-only `TURNSTILE_SECRET_KEY`, the
  honeypot, the fill time by a host-made shown-time token, the caps, the per-mailbox spam rule.
  ADRs 0720, 0721, 0722 and 0725; no migration. Decided while building: too many links is refused
  naming the key (criterion 6), not kept as spam; the shown time is keyed from the Turnstile
  secret, so customers skip it as they skip Turnstile; `intake.open` is the core read a pack's
  `x.forms.form` calls; `notify` is one user (no field holds several); the hourly cap is the
  platform's 200 until step 3's settings; Turnstile off on a testing host is Cloudflare's test
  keys, not a setting. After review: a submission's evidence (form, version, answers, certainty,
  via, rating) is host-only and only the door creates one; `answeredBy`, `anonymous` and
  `destination` are read from the published version; `intake.submit` takes the version shown;
  destination fields are filtered by what the intake lists; an anonymous form forgets the caller
  before any check; counts use `deleted_at IS NULL`; a raced first answer is told to send again.
  Not yet tried on a live host.

- **Step 3** — built — PR #429 — Forms pack spine (`feat/stage-29-forms-spine`): the Forms pack (`packs/forms`, ADR 0726): `forms.form`
  (publishable, slug as its address, kinds enquiry, sign-up, survey, feedback and staff, receipt
  on by default, a low-rating level) and `forms.submission` (the inbox: new, in hand, done, spam;
  owner by assignment rules; titled after its form); tools `form`, `submit` (customers and the
  public), `enter`, `move`, `markSpam`, `notSpam` (staff, `forms:answer`); views (new answers, in
  hand, spam, "Asked to hear from us", open forms) and Person and form tabs; the hourly cap setting
  (`personApproves`); the low-rating notice (an automation). Platform: `intake.open` takes a
  form's `slug`; `intake` gains `hourlyCap` (a form's) and `marketing` (a submission's,
  host-only). Decided while building: no public scope on a form (the public reads it only through
  `intake.open`, as a `when` cannot say who may answer); spam moves are `markSpam`'s and
  `notSpam`'s only, both `personApproves`; a form's status, dates, daily cap and address are
  `personApproves`; an old address redirects; the low-rating notice goes to the submission's owner,
  else the admins; the destination is a text no object answers to until step 6; the retention
  settings wait for step 7 and `x.forms.ask` and `forms:manage` for step 5; the pack is not added
  to the CRM's packs. Not yet tried on a live host.

- **Step 4** — not built — needs: step 2 — Hosted page, web and native blocks, headless entry.

- **Step 5** — in progress — branch `feat/stage-29-personal-links` — Personal links, the receipt
  and the form-link slot, Bookings' feedback, the `form_to_fill` attention kind.

- **Step 6** — not built — needs: step 2 — Leads as a destination.

- **Step 7** — not built — needs: step 3, step 4, step 5 — Erase, merge, retention (the reserved
  erase-completeness area).

- **Step 8** — not built — needs: step 3, stage 47 — Screens declared, the dashboard, e2e, the
  site and `SITE.md`.

- Later, not a numbered step: submission files with the trades work (issue #117), then framing by
  listed sites.

## Goal

A business builds its own forms in the admin, with no developer: an enquiry form ("ask about
membership", "request a quote"), a sign-up ("tell me when kids' classes start", "keep me
updated"), a survey of its members, and feedback after a class or a job. It puts a form on its
website built on the platform, in its app, or behind a link or QR code. A visitor fills it in with
no account; a member fills it in signed in, or from a personal link in an email after their class.
Every answer lands in one inbox in the admin, linked to the right Person, and, where the business
chose, as a record of another pack (a Lead, later a job request). Staff are told; the visitor gets
a short receipt. Spam is kept out without making real people solve puzzles. The exact words of a
"keep me updated" tick are kept with the answer. Waivers, health questions and signatures stay with
Agreements (stage 44): a form gathers information, an agreement is evidence of a promise.

This stage also owns **the public-write door**: the one reviewed way the public may create a
record. Reviews (stage 54) uses it and does not build its own.

## Who it is for

**Gyms and studios first.** Enquiries from the website ("ask about a trial", "kids' classes"),
interest lists for a new class or course, member surveys (how are we doing), a one-tap rating
after a class (and so of the class type and the coach), and an injury or incident report written
by staff (a staff-only form). What is specific: feedback ties to a booking, and through it to a
class and its coach; members are signed in on the app; children are dependants, so a form is never
sent to a dependant's own address, only to a guardian.

**Trades and services next.** A quote or job request with an address, the kind of job, preferred
times and photos of the problem; a call-back request; feedback after a job is done. What is
specific: **photos** matter far more than for a gym (step 8, built later with the trades work,
decision 8); the answer usually becomes a job or a quote (stages 39 and 35, not specced), so it
must be able to land as another pack's record; reviews drive their trade, and Reviews (stage 54) is
built on this stage's door; the person filling in a quote request is almost never a customer yet.

## What exists today (from the code, checked 2026-11-24)

- **The public can change nothing.** The seam's write check refuses every change a public caller
  records (`packages/core/src/visibility/writes.ts`: "The public change nothing"). The only public
  writes are purchases: `order.start`, `order.startHeld`, `subscription.start` (core, `hostInternal`)
  and the packs' `x.bookings.buy`, `x.courses.buy`, `x.memberships.buy`, `x.ticketing.orderStart`
  (`packages/core/open-operations.json`). The host writes for them with `recordHostChange` (ADR 0428).
- **A guest becomes a Person by address.** `resolveBuyer` (`packages/core/src/orders/guests.ts`)
  matches the address by the same-email rule (ADR 0247, `sameEmailPeople`), creates a Person in the
  call's batch when none has it, tells admins when several do, and refuses an erased address with
  the same words as a bad one ("That email address cannot be used"). A guest never reads a Person.
  An order is backed by a verified payment; a form is not.
- **Limits for outside callers** (`packages/core/src/customers/limits.ts`): a customer per account
  and operation; sign-in codes per mailbox (`mailboxKey` folds `+tags` and dots); the public only
  per client address at the edge, by a Cloudflare rate limiting rule (`docs/deploying.md`, "Public
  calls: a rule at the edge"). No client address is stored anywhere.
- **The site's call form** (`apps/marketing/src/worker.ts`, `signup.ts`): works without
  JavaScript (a POST answered with a redirect), a rate limit binding per client address, a honeypot
  field that returns "success" and stores nothing, a zod schema with length limits, no address or
  tracking data kept, nothing sent to a third party. It is the site's own Worker and table, not the
  platform.
- **Leads** (`packs/leads/index.ts`): `leads.lead` with person, organisation, status, source, owner
  from assignment rules (`packages/core/src/assignment/`), converted into a deal. **It requires
  Deals** ("Requires Deals."), which a gym does not use. Nothing creates a lead from outside.
- **Records the public reads**: the public scope (ADR 0438, a `public` declaration with a `when`
  condition, `packages/core/src/visibility/public.ts`).
- **Publishable records** with versions only a person publishes, an AI asking (ADRs 0441, 0446,
  0480).
- **Document fields** checked against a declared schema on every write, with `private` parts
  (ADR 0445); rich text as one fixed schema of it (ADR 0440, `packages/sdk/src/rich-text.ts`).
- **Media** (ADRs 0444, 0475): staff uploads only, type read from the bytes, in R2. Issue #117 (file
  upload from client apps) is open and unbuilt.
- **Routine mail** (ADR 0590, `packages/core/src/routine-mail/`): a shipped pack's declared emails,
  sent without approval to the record's customer Person, live guardians or a paid order's address,
  with daily caps per mailbox; an email is routine only when every value it shows, and its address,
  carry a person's mark (`routine-mail/marks.ts`, `core_value_mark`, migration 0750). **A visitor's
  typed address carries the public's mark, so a receipt to it would be held** today.
- **No consent or opt-out record exists.** Nothing in core or the packs records consent to be
  contacted or an unsubscribe (checked: no opt-out field on `core_person`, none in a pack). The
  draft's "the Person's existing `emailOptOut`" was wrong. Consent and unsubscribe belong to
  Notifications (stage 30, not specced); see "Keep me updated" below.
- **Restricted permissions gate tools, not record reads** (ADR 0625). A member or viewer reads every
  pack record through `record.list`; a pack-role account (Bookings' `coach`, Rostering's `team`,
  Ticketing's `door`) reads only its own pack's objects (`packRoleReaches`,
  `packages/core/src/pack-roles.ts`).
- **Agreements** (`packages/core/src/agreements/`): documents, versions nobody changes, acceptances,
  health questions with answers kept out of every bulk path. CONTEXT.md already says of an
  agreement document: "_Avoid_: form (stage 29's)".
- **Public pages the host serves**: `/buy` and `/order/$id` (`apps/app/src/routes/`), bypassed
  from Cloudflare Access by the list in `apps/app/src/server/access-layout.ts`.
- **Pack screens** (stage 47): spec agreed, being built in PR #303. Until it merges, a pack's staff
  blocks show only on the development page.
- **My account** (stage 48, spec on PR #311): one customer shell of sections and "Needs your
  attention" (`me.attention`, a fixed vocabulary of kinds in core, which already names a later
  `form_to_fill`).

## Decided at the interview (2026-11-24)

No interview was needed: each point had a best-practice answer, decided by the coordinator under
the owner's standing rule. The draft's assumption about how the business takes enquiries today
stands, to be checked with the business during setup.

| # | Decision |
| --- | --- |
| 1 | **How the business takes enquiries today is not asked**: the draft's assumptions stand and are checked with the business at setup |
| 2 | **A website enquiry goes into a Forms inbox in the admin, linked to the person**, not into Leads (which needs Deals). A trades business can still send its enquiries to Leads |
| 3 | **The sender gets a short automatic receipt** by email: fixed wording with the business's name, nothing they typed repeated back, a few a day per address at most |
| 4 | **After a class, members are asked both by email and in the app**, at most once a month each |
| 5 | **Ratings after a class are seen by owners and managers only**, not by coaches |
| 6 | **Anonymous or named is chosen per form.** Anonymous really means anonymous: no link to the person is kept at all |
| 7 | **An enquiry from an address already on file is kept and attached to that person, but changes nothing already on their record**; staff see it came from an unconfirmed address |
| 8 | **No file or photo uploads for the gym**: built later, with the trades work |
| 9 | **Forms appear on the business's website built on the platform, in the members' app, and as a link or QR code** (social media, a poster at the desk). Not on a website not built on the platform, for now |
| 10 | **Forms can ask "keep me updated by email"** and keep exactly who said yes, when, and the words they saw, ready for the business's news emails later. Whether the wording is enough is for the business to confirm with its lawyer |

## The design in one page

**A new platform door: the public may create one kind of record, through an intake.** An object
opts in with a new behaviour, `intake`. The host's one operation for it, `intake.submit`
(`hostInternal`, `toolOnly`, open to customers and the public), takes what is being answered, the
answers and an anti-spam token. It checks the thing answered is published and open to this caller,
checks every answer against its published shape, runs the abuse checks, matches or creates the
Person, and writes the submission, any mapped destination record and the Person's empty fields in
one batch, as the host's own change with the public's value marks. Nothing else opens public
writes; the seam's rule stays "the public change nothing" for every other path.

**The door is the platform's; Forms is its first user, Reviews its second.** What is answered is
either a **published form** (Forms: questions the business builds) or a **declared intake** (a
shipped pack's object with a fixed set of fields, as Reviews' review will be). The abuse checks, the
submitter's Person and certainty, personal links and the receipt are the same for both.

**A Forms pack holds the forms and the answers as records.** A **form** (`forms.form`) is a
publishable record whose questions are a document field in a fixed **question schema** the SDK
ships. Staff build it in a builder screen; publishing is a person's act (an AI may ask). A
**submission** (`forms.submission`) declares `intake`: it points at the form and the exact version
answered, the Person, how sure the host is it is theirs, and holds the answers. Submissions are an
inbox with states (new, in hand, done, spam). Because they are records, views, dashboards,
automations ("when a submission arrives") and the assistant work on them with nothing new.

**Where answers land** is the form's choice: always a submission; the name, email and phone
questions fill the Person's **empty** fields only (never overwrite, decision 7); and optionally one
destination record of an object that declares `intake` as a destination (a Lead when Leads is
installed; later a job request). A pack can add a relation field to submissions (Bookings adds
"booking"), so feedback is about a booking, and through it a class and a coach.

**Two ways in, one logic** (decision 9). A block in the business's client app (web and native
skins over one headless entry), and a hosted page on the host (`/f/<slug>`) for a link or a QR
code. A **personal link** (a token, kept as a hash, for one Person, one form, optionally one record,
used once) is how feedback after a class reaches a member, by email through a new routine mail slot
and in the app as a "Needs your attention" item in My account (decision 4).

**Spam is stopped in the host.** Cloudflare's Turnstile on every public form (its secret env-only),
the honeypot and minimum fill time the site uses, the edge rate rule, caps per form and per
deployment per hour, length and link limits, and a receipt limited per mailbox. A refused-as-spam
submission gets the same answer as a real one. Staff mark spam; spam is purged after 30 days.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **Open `my.create` (or `record.create`) to the public** | The public would create any record a tool names, with no form, version or abuse check between. One reviewed door for declared kinds of record keeps the rule "the public change nothing" true everywhere else |
| **A door inside the Forms pack only** | Reviews (stage 54) would need a second door of its own, with its own abuse checks. One door in core, two users |
| **Forms and answers as core tables** (as Agreements did) | Agreements went core for health data and records nobody changes. Answers here are ordinary business information that staff want in views, dashboards, automations and the assistant. Sensitive questions are sent to Agreements instead |
| **A form's questions as manifest fields** (each form an object) | A business builds forms at run time; objects are declared by shipped packs. A document field with a fixed schema holds any form, checked on every write |
| **A form writes straight into a Lead** (decision 2) | Leads needs Deals, which gyms do not use, and a survey or a review is not a lead. The submission is always kept; a Lead is an optional destination |
| **An outside form service, or a script that draws the form inside another site's page** | Answers would leave the host, or the host's code would run in pages it does not control. A site not built on the platform links to the hosted page; showing it in a frame there is deferred (decision 9) |
| **A puzzle for every visitor** | Turnstile decides invisibly for most people; a puzzle costs real enquiries. The honeypot and caps catch the rest |
| **An AI that answers or deletes submissions** | Public text is outside text: an AI may summarise and suggest "spam", never reply on its own, delete, or publish |
| **Waivers and health questions as forms** | Stage 44 holds them: versions nobody changes, enforcement before paying or booking, health answers out of every bulk path. The form builder has no health question kind |
| **Confirming the visitor's address before keeping an enquiry** (decision 7) | It loses enquiries, and anyone can type someone else's address anyway. The host keeps how sure it is instead, and nothing a visitor typed changes what a Person already has |
| **A consent flag on the Person, owned by Forms** | Consent to be contacted and unsubscribe are Notifications' (stage 30). Forms keeps the evidence (the tick, the words, the time) and hands it to stage 30's register |
| **A "my enquiries" section in My account** | Nothing a customer must act on; the receipt says it arrived. A waiting personal link is the one thing shown, as an attention item |

## Platform work and pack work

| Piece | Platform or pack | Notes |
| --- | --- | --- |
| The question schema and answer checking | Platform (`packages/sdk`) | A fixed document schema, like rich text. New |
| The `intake` behaviour, `intake.submit`, the submitter's Person | Platform (`packages/core/src/intake/`, new) | **New behaviour, new public write.** Amends ADRs 0402 and 0412 (the public may create, here only). Serves Forms and Reviews |
| Abuse checks: Turnstile, honeypot, fill time, caps, link limits | Platform | New secret `TURNSTILE_SECRET_KEY` (env-only), a rate limit binding, an edge rule for `/f/*` |
| Personal links | Platform | New core table, used once, refused a second time by the database |
| Anonymous submissions | Platform | No Person, no link id, no account in the audit row |
| Routine mail: a receipt to a public address; a form-link slot | Platform | **Amends ADR 0590.** Touches `routine-mail/` and the email gatekeeper |
| The `form_to_fill` attention kind | Platform (`me.attention`, stage 48) | A live personal link for the caller or a live dependant's guardian |
| The hosted page `/f/<slug>` | Platform (`apps/app`) | A public route, an Access bypass entry, `frame-ancestors 'none'` |
| Erase, merge and retention of submissions and links | Platform | Touches the erase-completeness area |
| Forms pack: form, submission; tools, views, dashboard, settings | Pack (`packs/forms`, new) | Composes `publishable`, `intake`, `states`, public scope, `owner` |
| Builder and inbox screens | Pack, as stage 47 screens | Need stage 47 to show in the admin |
| Form blocks (web and native) and headless hooks | Pack | Shared logic, separate skins |
| Leads as a destination | Pack (`packs/leads`) | Declares `intake` on `leads.lead` |
| Feedback after a class | Pack (`packs/bookings`) | A routine mail kind with the form-link slot, a "booking" field on submissions |
| Later, with trades: submission files | Platform | Private R2 objects, never public, purged with their submission (issue #117); not built for the gym (decision 8) |
| Later: the hosted page framed by listed sites | Platform | A human admin's list, `frame-ancestors`; not built now (decision 9) |

## The model

### Words (for CONTEXT.md)

**Form**: questions a business asks, published as versions. **Submission**: one set of answers to
one version of a form. **Intake**: the behaviour by which an object accepts records made by the
public or customers through the host's one door. **Submitter**: who sent a submission, with its
**certainty**: `account` (signed in), `link` (a personal link), `staff` (entered by staff),
`address` (an address a visitor typed, unconfirmed); an anonymous submission has none. **Personal
link**: a one-time link to one form for one Person, optionally about one record. **Consent line**:
a tick box on a form whose exact words are kept with the version.
_Avoid_: waiver, agreement (stage 44's), ticket (Ticketing's), lead (only for `leads.lead`), review
(stage 54's record, built on this door).

### The question schema (SDK)

A form's `questions` field is a list of items, each with a stable key: `text` (short or long, a
maximum length), `email`, `phone`, `number` (min, max), `choice` (single or several, up to 50
options), `date`, `rating` (1 to 5 stars, or 0 to 10), `yesNo`, `consent` (the words, required or
not, and its purpose: `contact`, `marketing`, `other`), and the non-questions `heading` and
`paragraph` (rich text). A `file` kind is added later with the trades work (decision 8). Each
question may be required and may say **show only if** one earlier choice or yes/no has a value (one
level, no loops). A question may **map** to the Person (`name`, `email`, `phone`) or to a field of
the destination object listed in its `intake` declaration. No `health` kind, no signature, no
payment. Limits: 60 items, 20 KB of answers, 5,000 characters in a long text, 3 links in any text.

### The `intake` behaviour

Declared on an object of a shipped pack, read by the host, refused in a runtime extension (like
`screens`):

```ts
intake: {
  role: "submission",            // or "destination"
  form: "form",                  // relation to the form record (a Forms submission)
  // or, for a declared intake (Reviews): fields: ["rating", "text"] answered directly
  answers: "answers",            // the document field holding the answers (a Forms submission)
  person: "person",              // the relation set to the submitter's Person
  certainty: "certainty",        // a select the host sets
  fields: ["name", "notes"],     // fields a form's mapping may fill (a destination only)
  startsIn: "new",               // the state a new record starts in
}
```

A form names at most one destination object. The host fills its listed fields from mapped
answers, sets its Person and its `source` where it has one (`website`), and the destination's
`owner` comes from assignment rules as for any create. A declared intake (no `form`) is answered
only by its own pack's tool, with the fields' own schemas as its shape; its ADR is written by this
stage, its first object by stage 54.

### The submitter's Person

One function beside `resolveBuyer`, sharing its matching (moved to a shared helper, not copied):
signed in, it is the customer's Person (`account`); a personal link, the link's Person (`link`);
otherwise the typed address is matched (`address`): one match links it, none creates a Person,
several link none and admins are told. An erased or invalid address is refused as `resolveBuyer`
refuses it, with the same words. With `address` certainty the host **only fills a Person's empty
fields** and never changes a name, address or phone already there, never touches a customer
account, and never sends anything to an existing Person but the receipt (decision 7). The inbox
shows "unconfirmed address" on such a submission.

**Anonymous forms** (decision 6): a form marked anonymous has no email question that maps to the
Person, links no Person, keeps no personal link id and no account, and its audit row names only the
actor kind (`public` or `customer`). A signed-in member may answer one; nothing records that they
did. An anonymous form cannot be sent by personal link, cannot have a destination, and its "once
per person" limit is not available. The builder says so when anonymous is ticked.

### Records (Forms pack)

- **`forms.form`**: title, slug, kind (`enquiry`, `signup`, `survey`, `feedback`, `staff`),
  questions, thank-you text, who may answer (`public`, `customers`, `links`, `staff`), anonymous
  (yes/no), destination object, who is told (users, or the owner rule), receipt on or off (on by
  default, decision 3), a low-rating alert level, open from and until, a per-day cap.
  `publishable` (content: title, questions, thank-you); states `draft`, `open`, `closed`. Public
  scope: title, questions, thank-you, while `open` and published.
- **`forms.submission`** (`intake` role `submission`): form, version, person, certainty, answers
  (document, `private` to customers and the public), rating (copied from the first rating question,
  for dashboards), via (`site`, `app`, `page`, `link`, `staff`), owner, notes. States `new`,
  `inHand`, `done`, `spam`. Nobody outside reads it: no customer or public declaration.

### "Keep me updated" (decision 10)

A `consent` question with purpose `marketing` is a tick box, never ticked by default. When ticked,
the submission is the evidence: who (the Person), when (the submission's time), and the exact words
(the published version the submission points at, which nobody changes). Forms records nothing on
the Person. **Consent to be contacted and unsubscribing are Notifications' (stage 30)**: when stage
30 builds its consent register, a ticked marketing line is written there in the submission's batch
(through stage 30's operation, as the host's change with the submitter's mark), and stage 30's
build carries over the ticks already kept. Until then the Forms pack ships a view, "Asked to hear
from us", of ticked submissions with their Person, time and wording. Staff and an AI cannot tick it
for someone; a staff-entered submission (`x.forms.enter`) has no marketing line. Sending news is
stage 30's and 36's. Whether the wording is enough, and how long to keep it, is for the business to
confirm with its lawyer.

### Operations and tools

| Name | Audience | Who may | Risk | What |
| --- | --- | --- | --- | --- |
| `intake.submit` (core, `hostInternal`, `toolOnly`) | customer, public, staff | through a pack tool only | write | The door above. **Opens a write to the public: reviewed change** (ADR 0402) |
| `intake.link` (core) | staff, automation | `forms:manage`; routine mail | write | Makes a personal link; the token given once |
| `x.forms.form` | public, customer | anyone | read | A published, open form by slug, with a signed time for the fill-time check |
| `x.forms.submit` | public, customer | anyone | write | Calls `intake.submit`. **Public write** |
| `x.forms.enter` | staff | `forms:answer` (every staff role) | write | Staff enter a phone or paper enquiry, or a staff form (certainty `staff`) |
| `x.forms.move` | staff | `forms:answer` | write | New, in hand, done |
| `x.forms.markSpam`, `x.forms.notSpam` | staff | `forms:answer` | write | An AI may call `markSpam` only as a suggestion a person confirms (ADR 0552) |
| `x.forms.ask` | staff | `forms:manage` | write | Send a form by personal link to chosen people (one email each, through approval as usual) |
| Building and publishing | staff | `forms:manage`; publish `records:publish` | write | `record.update`, `record.publish`; an AI may draft and ask to publish (ADR 0480) |

All customer and public tools are `mcp: { expose: false }`, never queued.

Settings (human admin only, never an AI): Turnstile on or off for testing hosts only, the hourly
cap per deployment (default 200), how long done submissions are kept (default: until erased), spam
kept 30 days.

### Abuse checks, in order, inside `intake.submit`

1. The edge rule (per client address, at the zone) has already counted the call.
2. The form is published, open, within its dates and open to this caller; else not found.
3. Turnstile's token is verified against Cloudflare with the env-only secret (public callers; a
   signed-in customer and a personal link skip it). A missing secret refuses public submissions and
   tells admins once.
4. The honeypot is empty and the form was shown at least 3 seconds ago (the signed time from
   `x.forms.form`). Failing either answers success and stores nothing.
5. Per form per day and per deployment per hour caps; over the cap, admins are told once and the
   caller gets "try later".
6. The answers check against the version (types, required, lengths, links). Errors name the
   question key only, never the value.
7. A submission from an address that sent 5 to this form today (by `mailboxKey`) is kept as
   `spam` and answered as success. (Settled at step 2: more links than the limit is refused naming
   the question's key, as criterion 6 says, ADR 0720.)

No client address, user agent or device fingerprint is stored.

### Who sees what (decision 5)

- **The inbox, answers and ratings** are read by staff accounts (admin, member, viewer: the
  business's owners and managers). **Pack-role accounts** (Bookings' `coach`, Rostering's `team`,
  Ticketing's `door`) read none of it: the Forms pack gives them no reach, and `forms:answer` is not
  grantable to pack roles. So a coach on the coach role never sees ratings of their classes.
- A coach who is also given a full staff account is, for this stage, a manager. A narrower staff
  read (ratings for admins only, or a coach's own classes) waits for per-object staff reads (stage
  14a's roles and teams) and is not built here.

### Screens

- **Web admin** (stage 47 screens): Forms (list, builder with a live preview, publish, share: the
  link, a QR code and the client block's name), Inbox (submissions by form and state, the record
  page with answers drawn as plain text, never HTML, and "unconfirmed address" where certainty is
  `address`), a Forms dashboard (submissions per week by form, average rating per form, per class
  type and per coach when Bookings is installed).
- **Customer web** (client app blocks): Form (any published form), Thanks; the hosted page
  `/f/<slug>` renders the same form for a link or a QR code.
- **Native**: Form and Thanks in the native skin over the same headless entry.
- **My account** (stage 48): no Forms section (customers read no submissions). A live personal link
  is a **`form_to_fill`** item in "Needs your attention" (for the member, or for a child's guardian),
  opening the form; it goes once answered or expired. This is decision 4's app prompt.

### Notifications and email

- Staff: an in-app notice per submission to the form's chosen people or the owner, by their own
  email preferences; a notice for a rating at or under a form's alert level; the daily digest
  counts new submissions.
- The submitter: one **receipt** (decision 3; fixed words: the business's name, the form's title,
  "we got your message", no echo of their answers or name) as routine mail to the typed address, at
  most 3 a day per mailbox, never to an erased address, never for an anonymous form. **Platform: ADR
  0590 amended** so a declared receipt kind may go to a public-marked address when it shows no
  public value.
- Feedback after a class (decision 4): Bookings declares a routine mail kind `bookings.feedback`
  with a **form-link slot** (the host makes the personal link while preparing the email), sent a
  set number of hours after a ticked booking (default 3), at most once per member per 30 days. A
  dependant's booking goes to the live guardian (routine mail's guardian rule), never to the
  dependant's own address. The same personal link is the app's `form_to_fill` item; answering
  either uses it up. Links expire after 7 days.

### What an AI may do

May: draft a form and ask to publish it (a person approves); read submissions (they are outside
text, so its later writes are marked as an AI's); summarise feedback; suggest spam; draft a reply
that goes through approval. May not: publish or close a form without a person, change any abuse
setting, delete a submission, send anything on its own, tick a consent line, or create a personal
link outside an approved send.

### Privacy and erase

- Staff read submissions; customers and the public read none, not even their own.
- Answers are personal data in the `rec_*` views, so in dashboards, exports and the assistant. The
  builder warns on questions that look like health or children's details and points to Agreements.
- Every submission is audited with actor `public`, `customer` or the staff member; answers are not
  copied into the audit row (only the question keys). An anonymous submission's row names no
  account.
- `person.erase` deletes their submissions and personal links; merge re-points them. An anonymous
  submission has no Person to erase.

## Out of scope (and deferred)

- **File and photo uploads** (decision 8): built later, with the trades work, as step 8 below.
- **Forms on a site not built on the platform in a frame** (decision 9): such a site links to the
  hosted page; framing by listed sites is a later step.
- Payment in a form (use an order), quotes and prices (stage 35), jobs (stage 39).
- Signatures, waivers, health questions (stage 44). A form records no acceptance.
- Replying to a submission as an email thread (stage 36), SMS and push (stage 30).
- A consent register and unsubscribe (stage 30); sending news (stages 30 and 36).
- Multi-page forms, branching beyond one "show only if", calculations, saving a half-filled form.
- A customer's "my enquiries" list; editing a submission after sending.
- Reviews and showing them on the website: stage 54, built on this stage's door and personal
  links.
- Ratings for a coach's own classes; ratings for admins only (stage 14a's per-object staff reads).
- Forms in more than one language; importing forms from another tool.
- Moving the composableos.dev call form onto the platform (it is not a host product).

## Acceptance criteria

1. A public `record.create`, `my.create` or any operation but `intake.submit` creating a record is
   still refused; `open-operations.json` lists `intake.submit` as `hostInternal` and `toolOnly`.
2. A visitor submits a published enquiry form on a client app with no account: one submission,
   one new Person with the address, certainty `address`, in one batch; staff are told.
3. The same address as an existing member: the submission links that Person; their name and phone
   are unchanged; only empty fields fill; the inbox shows "unconfirmed address". Several Persons
   with it: linked to none, admins told.
4. An erased or invalid address is refused with the same words as `order.start` uses.
5. A draft, closed, unpublished or out-of-dates form is not found for the public; a `customers`
   form is not found for the public; a `links` form needs a live link.
6. An answer that breaks the version (missing required, wrong type, too long, too many links) is
   refused naming the question key, with no value in the error or the audit row.
7. A form edited after publishing: new submissions point at the new version, old ones keep theirs.
8. Turnstile: a public submission with no token or a bad one is refused; with the secret unset,
   public submissions are refused and admins are told; a signed-in customer needs no token.
9. A filled honeypot, or a submission faster than 3 seconds, gets the success answer and stores
   nothing. Over a cap, "try later" and one notice to admins.
10. No client address, user agent or fingerprint is stored (a test over every table written).
11. An anonymous form: a submission (public or signed in) has no Person, no link id, no account in
    its record or audit row, sends no receipt, and the form cannot be given a destination or sent
    by personal link.
12. A Lead destination with Leads installed: a lead with the Person, source `website`, owner from
    assignment rules. Without Leads the destination cannot be chosen.
13. A personal link opens its form once; a second use, at once or racing, is refused by the
    database; an expired link and a wrong token are one answer.
14. A ticked booking, with feedback on, sends one feedback email after the set hours, no more than
    once per 30 days per member; a dependant's goes to the guardian, none to the dependant's
    address; the answer links the booking. The same link shows as `form_to_fill` in My account and
    is gone once answered by either way.
15. The receipt goes once to the typed address with fixed words and nothing the visitor typed;
    the fourth in a day to one mailbox is not sent.
16. A ticked `marketing` consent is kept with the submission and its version's words and appears
    in "Asked to hear from us"; it is never ticked by default; staff and an AI cannot set it.
17. A pack-role account (coach, team, door) can read no form, submission or rating, by record
    reads, views, dashboards or search.
18. An AI may draft a form; its publish waits for a person with `records:publish`.
19. The hosted page renders a form, posts with an idempotency key, sends `frame-ancestors 'none'`,
    and `/f/*` is in the Access bypass list and its test.
20. Web and native blocks render every question kind from one headless entry.
21. Erase deletes a Person's submissions and links; merge re-points them.
22. `cos ext check` and `cos ext test` pass for Forms; e2e: one journey per way in (client app,
    hosted page, personal link) and one for staff handling the inbox.
23. The site and `SITE.md` list Forms with what is built.
24. Later (step 8, with trades): a public upload accepts only JPEG, PNG, WebP, HEIC and PDF by
    their bytes, at most 10 MB and 5 per submission; it is never served to customers or the public;
    unattached uploads are purged within a day; location data is stripped; erase deletes files.

## Dependencies

Built: stages 22 and 23 (audiences, the HTTP surface), 24 (blocks), 25 (`resolveBuyer`), 28
(publishable, public reads, media), 41 (document fields), 15 (Leads), 31a (bookings, ticked
attendance), routine mail (ADR 0590), 44 (Agreements, for the boundary). **Being built: stage 47**
(PR #303; the builder and inbox screens show in the admin once it merges). **Spec on PR #311:
stage 48** (the `form_to_fill` kind is added to `me.attention`; if stage 48 is not built yet, step 5
adds the kind when it is, and the email alone carries feedback meanwhile). Not needed: 30, 36, 39,
14. Trades' "after a job" waits for a pack with jobs (stage 39) and uses the same form-link slot.

Stages that lean on this one: **Reviews (stage 54)** (the door, the declared intake and personal
links); **Notifications (stage 30)** takes over the marketing tick into its consent register; the
website builder (a form section); client notes with files (the upload piece, issue #117: build it
once, in step 8 here or there, whichever is first).

## Migrations and numbers

Block **BG** in [`parallel-work.md`](../parallel-work.md): migrations 1010–1029, ADRs 0720–0729.
Expected migrations: `core_intake_link` (personal links: hash, Person, form, optional record,
expiry, used-at; a trigger refuses a second use, as Rostering's offers are kept to one take,
migration 0812); spam and retention purge needs no table. Step 8 (later): `core_intake_file`. No
`core_write_guard` remake. No `x_*` table is touched by a migration. New permissions (the pack's):
`forms:manage` and `forms:answer`.

ADRs the build writes:

1. The `intake` door: one public write, a submission or a declared intake, a destination
   (**ADR 0720**); amends ADRs 0402, 0412 and 0438.
2. The submitter's Person and certainty, empty fields only (**ADR 0721**); amends ADR 0428 (the
   shared matcher).
3. Abuse checks: Turnstile, honeypot, fill time, caps, spam kept as success (**ADR 0722**).
4. Personal links, used once (**ADR 0723**).
5. The receipt to a public address and the form-link slot (**ADR 0724**); amends ADR 0590.
6. Anonymous submissions (**ADR 0725**).
7. The Forms pack: forms, submissions, who reads them (**ADR 0726**).
8. Later, step 8: submission files (**ADR 0727**); amends ADR 0444.

## Suggested build order

| Step | What | Areas | Beside |
| --- | --- | --- | --- |
| 1 | The question schema and answer checking | `packages/sdk` (a new file, the document schema) | Anything |
| 2 | `intake`, `intake.submit`, the submitter's Person, anonymous submissions, abuse checks, Turnstile, caps | `packages/sdk` manifest and contract, `packages/core/src/intake/` (new), `orders/guests.ts` (sharing the matcher), `open-operations.json`, the API golden files, `wrangler.jsonc`, `worker-configuration.d.ts`, `docs/deploying.md` | **Collides** with any work in `orders/` (Shop, Offers, Invoices, the till, stage 48 step 6), the visibility seam and the contract golden files. Not beside another new behaviour or another manifest key in the SDK (stage 47's `screens`, stage 48's `portal`: coordinate the files) |
| 3 | Forms pack spine: form, submission, states, tools, views ("Asked to hear from us" among them), settings, notices, the low-rating notice, the staff form kind | `packs/forms` (new), the product's `packs` list | Steps 4, 5, 7; any other pack |
| 4 | Hosted page, web and native blocks, headless entry | `apps/app` routes, `access-layout.ts`, `packs/forms/blocks`, `client/` | Steps 3, 5, 7; collides with other public-route work in `access-layout.ts` |
| 5 | Personal links, the receipt and the form-link slot, Bookings' feedback, the `form_to_fill` attention kind | `packages/core/src/intake/`, `routine-mail/`, the email gatekeeper, migration 1010, `packs/bookings`, `me.attention` (stage 48's) | **Collides** with the email gatekeeper, routine mail, Bookings work and stage 48's `me.attention` |
| 6 | Leads as a destination | `packs/leads` | Anything but other Leads work. Not needed by the first gym client |
| 7 | Erase, merge, retention | `person.erase`, `records/erase.ts`, `retention.ts`, `purge.ts` | **Reserved area** (erase completeness): alone, or after whoever holds it |
| 8 | Screens declared (after stage 47), the dashboard, e2e, the site and `SITE.md` | `packs/forms/index.ts`, `apps/app/e2e`, `apps/marketing` | After 47; the site file conflicts with any other site change |
| Later | Submission files with the trades work: uploads, private R2, purge (issue #117); then framing by listed sites | `packages/core/src/intake/`, media HTTP, `purge.ts`, R2 binding; the hosted page's headers | **Collides** with media work and the erase-completeness area |

**Steps 1 and 2 are the spine**, one session, and come first; step 2 gets a security review as
stage 25 did. After them, three sessions at once: (3, 6), (4), (5); then 7; 8 after stage 47.

## Size

**Large.** The first public write that is not a purchase, one new pack with a builder, and changes
to routine mail. Smaller than drafted: uploads and framing moved to later steps.

## Decided by this spec, open to override

| Choice | Decision |
| --- | --- |
| The public-write door | One door, `intake.submit`, in core; not a general public create. Forms and Reviews both use it |
| Who reads submissions | Staff accounts; nobody outside, not even the submitter; no pack-role account |
| A visitor's typed address | Links or creates a Person with certainty `address`, filling empty fields only; no email confirmation |
| Spam | Turnstile on every public form; no visible puzzle; honeypot and fill time as the site does; spam kept 30 days, then purged |
| Agreements | A form records no agreement, signature or health answer; those are stage 44's |
| Reviews | Not in this stage: stage 54 uses the door, a declared intake and personal links |
| Feedback after a class | Default 3 hours after the class, at most once per member per 30 days, link valid 7 days; a child's goes to the guardian |
| Ratings and coaches | Coaches on the coach role see none; a narrower read waits for stage 14a |
| Anonymous forms | No Person, no link, no account kept; no receipt, no destination, no personal link |
| "Keep me updated" | Kept as the submission (who, when, the version's words); never ticked by default; moved into stage 30's consent register when it is built; nothing on the Person |
| The receipt | On by default per form; at most 3 a day per mailbox; fixed words |
| Uploads | A later step with the trades work; images and PDF only |
| Outside sites | Link to the hosted page; the hosted page refuses to be framed until framing by listed sites is built |
| Leads | Stays dependent on Deals; gyms use the Forms inbox; Leads is an optional destination |
| Caps | 200 submissions an hour per deployment, a per-form daily cap set on the form, 5 a day per mailbox per form before spam |

## Questions for the owner

None open. The ten points were decided as best practice (decisions 1 to 10); the owner may override
any of them.

## Risks

- **Security.** The first public write that is not a purchase: the largest new surface since stage
  25. Mail sent to an address anyone can type (mitigated: fixed words, per mailbox caps). Stored
  text shown to staff (drawn as text, never HTML; links not made clickable). Prompt injection
  through answers into the assistant (outside text rules).
- **Privacy.** A typed address that is someone else's attaches a stranger's message to a member
  (staff see "unconfirmed address"; nothing reaches the member). Free text where people write health
  details anyway. Ratings tied to a named coach, readable by every full staff account. Anonymous
  forms must really be anonymous (no Person, no link id, no account kept). The consent wording for
  news emails, and how long enquiries are kept, are for the business to confirm with its lawyer.
- **Money.** None: no form charges or refunds anything.
- **Needs the real thing.** Turnstile with a real site key on a real hostname; the native form on
  real phones; receipts' delivery from a real email connection; a real client's forms and volumes to
  set caps.
