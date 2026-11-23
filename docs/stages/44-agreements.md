# Stage 44: Agreements

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md) (Customers
and audiences, the visibility seam, Behaviours, Orders and payments), [`CONTEXT.md`](../../CONTEXT.md),
ADRs [0402](../adr/0402-staff-and-customers.md) to [0404](../adr/0404-behaviours-are-the-vocabulary.md),
[0427](../adr/0427-orders-are-priced-by-the-host-and-paid-only-by-a-verified-payment.md) to
[0429](../adr/0429-payments-gatekeeper-verified-events-and-refunds.md),
[0435](../adr/0435-sellable-what-may-be-bought-and-what-a-paid-line-grants.md),
[0440](../adr/0440-rich-text-is-data.md), [0446](../adr/0446-publishable-without-its-public-half.md),
[0449](../adr/0449-permissions-granted-one-by-one.md), [0456](../adr/0456-the-hosts-sign-in-mail.md),
[0480](../adr/0480-an-ai-asks-to-publish-a-person-approves.md),
[0485](../adr/0485-recurring-billing-the-provider-runs-the-schedule.md) to
[0491](../adr/0491-continuation-offers.md), [0503](../adr/0503-time-windows-and-staff-only-on-the-transition-engine.md),
[0507](../adr/0507-what-the-bookings-review-needed-of-the-platform.md),
[0510](../adr/0510-what-a-subscription-grants.md) to [0513](../adr/0513-a-granted-holder-keeps-what-it-was-granted.md),
[0540](../adr/0540-the-family-link.md), [0550](../adr/0550-timed-moves-and-a-cancel-that-races-a-booking.md),
[0552](../adr/0552-a-tool-a-person-approves.md), [0560](../adr/0560-a-paid-line-moves-a-record-that-exists.md),
[0571](../adr/0571-a-calendar-file-made-by-the-email-gatekeeper.md) (a calendar file made by the
email gatekeeper), [0573](../adr/0573-runs-over-the-rate-rail-wait-their-turn.md) (deferred runs)
and [0574](../adr/0574-an-idempotency-key-on-an-email-send.md) (an idempotency key on an email
send), all three merged with PR #256; stages
[31](31-bookings.md) (drop-ins, the family link), [32](32-memberships.md) and
[43](43-practitioners.md) (the care link's consent); issue
[#245](https://github.com/timoconnellaus/composable-os/issues/245) (disputes);
`packages/core/src/orders/` (`orders.ts`, `once.ts`, `guests.ts`, `events.ts`, `refund-due.ts`),
`packages/core/src/subscriptions/subscriptions.ts`, `packages/core/src/records/person-approves.ts`,
`records/publish.ts`, `records/states.ts`, `visibility/guardians.ts`, the migrations 0650 (the
family link's guard) and 0670 (`core_write_guard`), and `packs/bookings/index.ts` (the booking's
declarations).

Status: **spec agreed** (owner interviewed 2026-11-23; the eight questions answered the same day,
decisions 15 to 22; step 1 built on `feat/stage-44-documents`, ADRs 0640 and 0641; step 2 built on
`feat/stage-44-acceptances`, ADRs 0642 and 0643; step 3, enforcement, built on
`feat/stage-44-enforcement`, ADR 0644; step 4, the copy and the signed PDF, built on
`feat/stage-44-copy`, ADR 0645; step 8, erase, merge and retention, built on `feat/stage-44-erase`, ADR
0646; build notes at the end).
Builds on stages 25, 31a and 32. The first client is a gym moving from another system. It must be in
place before members pay or train on the new system (decision 13).

**This is not legal advice, and the platform ships no legal wording.** A business writes its own
documents, with its own advice. This stage records what a person agreed to, how and when, and stops
anyone paying or booking without it. Whether a document does what the business needs is the
business's question, for its insurer and its lawyer (the list at the end).

## Goal

A business writes the documents its members must agree to: its membership terms, a waiver, health
questions before exercise, and a parent's consent for a child. It says where each is needed: when
someone buys a membership or a pass, and before they book a class. A person reads the document and
agrees, by ticking a box and typing their name or by drawing their signature, on the website or in
the app. A visitor paying for one class agrees on the way to paying. A parent agrees for their
child. Staff record a paper form signed at the desk. Each agreement keeps the exact words the person
saw, for good. The person gets a copy by email; the business can download a PDF. When the business
changes a document, it says whether everyone must agree again before their next booking. Nobody
pays, starts a membership or books for the first time without the agreements they need: not a
member, not staff for them, not the assistant, not an API call.

## Why it matters (the coordinator's reasoning, as given to the owner)

A membership is a contract whether or not anything is signed. What this stage keeps is **evidence**
of what was agreed:

- the authority for charging a card every month, and the answer to a bank dispute (a chargeback,
  issue #245): the words, the time, the person and the copy they were sent;
- the terms that cost money: billing, cancelling, pausing, price changes;
- the waiver and assumption of risk, for the business and its insurer;
- a parent's consent for a child, who cannot agree for themselves;
- consumer rules in the business's state that may ask for a written agreement, a copy given to the
  member and a cooling-off period. Which rules apply to the first client is not confirmed
  (decision 11, and the list at the end).

## What exists today (from the code)

- **Nothing records an agreement.** Before this stage no table held a document, a version a person
  accepted, a signature or health answers. Roadmap stage 29 (Forms, not specced) listed "waivers
  with a signature"; this stage takes waivers from it. (Step 1 is built: documents, versions,
  publishing and attaching, migration 0850, ADRs 0640 and 0641. Nothing yet records an acceptance.)
- **Orders are priced and checked in one place.** `createOrder` (`orders/orders.ts`) starts every
  order (`order.start`, and `order.startHeld` for a record made held with its order, ADR 0560). Per
  line rules already run there in the order's batch: capacity holds (`claimOrderPlaces`) and the
  one-per-Person rule (`holdOncePerPerson`, ADR 0512), which refuses a guest with the same answer for
  every address.
- **Subscriptions start in one place.** `startSubscription` (`subscriptions/subscriptions.ts`) opens
  the provider's page for a signed-in customer, a guest by address, or staff for a Person; the
  subscription and what it grants exist only once the provider's verified event says so (ADRs 0485,
  0510). A continuation offer is taken only by its own signed-in person (ADR 0491).
- **Bookings are made through the transition engine.** `bookings.booking` declares its create
  rules (`states.create`: who may create in which state, a window, staff-only class types, a closed
  class), its claim on the class, its spend of an allowance, and its guardians (ADR 0540). The engine
  applies them for every actor on every path (`record.create`, `my.create`, a pack tool, MCP).
- **A guest's drop-in is nobody's until paid** (ADR 0560): the booking is held with its order, and the
  verified payment matches the order's address to a Person; several matches wait for staff
  (`order.setPerson`).
- **Guards at commit** exist in two shapes: a guard table whose trigger aborts the batch unless a
  condition still holds (`core_person_link_guard`, migration 0650), and `core_write_guard` with
  kinds (`claimed`, `claimant`, `series`, `full`, `unmoved`, migration 0670).
- **`personApproves`** (ADR 0507) and **`actors: ["human"]`** (ADR 0552 and the family link's
  operations): two ways to keep an act a person's. Publishing a record lets an AI *ask*, and a person
  approves (ADR 0480).
- **Versions** exist for publishable records (`core_publish_version`, ADR 0446): snapshots a person
  publishes, which can be unpublished and restored.
- **Rich text** is one schema of blocks (ADR 0440), with an editor block from stage 28.
- **Mail the host composes itself** goes out through `callAsHost` (purpose `orders` for an order's
  confirmation, which applies at once unless the deploy-time floor denies it; purpose `sign-in` for
  codes, ADR 0456). The only attachment any email can carry is the calendar file the email gatekeeper
  builds from checked values (ADR 0571, merged with PR #256). A send may carry an idempotency key, so
  a retried step sends nothing twice (ADR 0574); an automation's runs over the runs-per-minute rail
  wait their turn instead of being dropped (ADR 0573). Neither changes host mail: `callAsHost` is
  not an automation run.
- **Routine mail** (the owner's decision of 2026-11-23 that a pack's fixed routine emails send
  without approval) is being built on `feat/routine-mail`; it is not on `main`, and nothing here
  waits for it.
- **Refunds** always wait for a person with `orders:refund` (ADR 0429); a refund the host owes is
  written as `core_sellable_refund_due` and asked for by the minute cron (ADR 0560).
- **No date of birth** on a Person. A child is known to the host only as a **dependant** of a live
  family link.

## Decided at the interview (2026-11-23)

| # | Decision |
| --- | --- |
| 1 | **A platform piece called Agreements** that any pack can require (memberships, tickets, courses, practitioner consent). Not a Memberships feature, and not an outside signing service |
| 2 | **How a person agrees** is chosen by the business per document: tick a box and type their name, or draw a signature |
| 3 | **Each acceptance records**: the exact wording they saw (that version, kept for ever, never edited); who agreed and when; how they agreed; a copy emailed to them; a PDF of the signed document the business can download. **The device and internet address are not recorded** |
| 4 | **Four documents at launch** for the first client: membership terms (billing, cancelling, pausing, price changes); a waiver and assumption of risk; health questions before exercise; parent or guardian consent for a child |
| 5 | **Health questions are a form with answers** (yes or no questions, and a note if yes) that staff can read. It is health information |
| 6 | **Agreement is required** before a person can pay for or start a membership or pass, and before their first booking |
| 7 | **When a document changes, the business chooses each time**: a small change (no action), or everyone must agree again before their next booking. The version each person accepted is kept either way |
| 8 | **Members moving over** from the current system agree afresh the first time they sign in to the new one |
| 9 | **Children: both paths.** A linked parent agrees on the child's behalf in the app (recorded as the parent's agreement for that child), and staff can record that a paper form was signed |
| 10 | **Staff can record "signed on paper"** for adults too, with the date and who recorded it: a staff entry, never shown as the member's own acceptance |
| 11 | **A cooling-off period is a setting** (days; 0 turns it off): a new member can cancel within it for a full refund, which still goes through approval like every refund. What the law requires in the first client's state is not confirmed |
| 12 | **Only a person with a specific permission writes and publishes documents.** The AI assistant may draft but never publish |
| 13 | **Start now**, in parallel with other work. It must be in place before members pay or train on the new system |
| 14 | **The insurer's and the lawyer's requirements are not known.** Use sensible defaults, and list what to confirm with them |

### Answered by the owner (2026-11-23, the spec's eight questions)

| # | Decision | Was question |
| --- | --- | --- |
| 15 | **On erasure**, each acceptance is kept, detached from the person, for a set time (the retention setting, default 7 years), then deleted. **Health answers are deleted at once** | 1 (recommended) |
| 16 | **Cooling off after classes were used**: a full refund regardless | 2 (recommended) |
| 17 | **Cooling off covers new members' memberships only**: not passes, and not existing members moving over | 3 (recommended) |
| 18 | **A health "yes"**: the coach sees a mark beside the name only ("health note"), with no details; staff with the health permission can open it | 4 (recommended) |
| 19 | **After a health "yes" the member can still book**, and staff with the health permission are told | 5 (recommended) |
| 20 | **A teenager with their own sign-in**: a linked parent or guardian agrees, or a paper form; never the teenager alone. The host holds no date of birth, so staff mark a Person as a minor (below) | 6 (recommended) |
| 21 | **The emailed copy of the health form does not include the answers** | 7 (recommended) |
| 22 | **A desk-tablet signing mode is built now** (the member signs on the business's own device): changed from the recommendation. Designed below, [Signing at the desk](#signing-at-the-desk-decision-22) | 8 (changed) |

## The design in one page

**Agreements is a core capability with its own tables, not records.** A **document** has a working
copy and **versions**. A version, once published, is never changed or deleted by anyone (the
database refuses it). Only a person with `agreements:manage` publishes, and an AI cannot even ask.

**A pack marks where agreement may be needed; the business decides what is needed there.** An
object declares an **agreement point** with a new behaviour, `agreements` (buying a membership,
buying a pass, making a booking). In the admin, the business attaches its documents to points ("the
waiver is needed when buying a membership or a pass, and before a booking"). No document is needed
anywhere until a person publishes one and attaches it.

**One question, asked in one place, guarded at commit.** `agreementsDue` answers "what must this
Person still agree to for this point". The orders pipeline asks it when an order or a subscription
starts; the transition engine asks it when a record enters a declared state (a booking made). The
write's batch carries a guard: if any document was published, attached or retired since the read,
the batch fails and the caller is asked to look again. So no path to pay, subscribe or book skips
it.

**An acceptance is a row nobody can change.** It holds the version and the hash of what was shown,
who it is for, who agreed (themselves, a guardian, a guest with an order, or staff from paper), how
(typed name, drawn signature, paper, or in person on the business's device) and when. The database
refuses any change to what it says. A
drawn signature is kept as its strokes, not an image. Health answers sit in their own table that no
`rec_*` view, search, export, dashboard or AI reads.

**The copy and the PDF are made from the stored version.** The host emails the copy as its own mail
(as it sends an order's confirmation), with a PDF the email gatekeeper builds from checked values,
as it builds the calendar file. The business downloads the same PDF, built on demand. Nothing is
kept as a file.

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **A feature of the Memberships pack** | Decision 1. Tickets, courses and practitioners' consent need it too, and the checks must sit in the orders pipeline and the transition engine, which a pack cannot hook (ADRs 0404, 0405) |
| **An outside signing service** | Decision 1. Members would leave the app to sign; each signature costs money; the record would live in someone else's system; the check before paying would wait on their webhook; and health answers would leave the host |
| **A pack with its own objects** (`x_agreements_*` tables) | Extension rows are in `rec_*` views, so health answers would reach SQL, dashboards, exports, search and the assistant; immutability and a guard inside the order's batch are host code. "Rules live in the host" (ADR 0404) |
| **Documents as `publishable` records** (reusing `core_publish_version`) | Publishing there is `records:publish`, an AI may ask to publish (ADR 0480), and a version can be unpublished or restored. Agreements needs its own permission, no AI publishing at all, "agree again" on each version, effective dates and versions the database protects because acceptances point at them. The rich text schema and the editor block are reused; the version store is not |
| **"Requires document kind X" written by the pack** | A pack cannot know a business's documents: one gym has one waiver, another has a waiver for kids' classes only. The pack names the point; the business attaches documents to it. A pack may *suggest* kinds for its point, which the admin shows |
| **Checking in a block, or in a pack's tool** | A block holds no rules (ADR 0401), and a tool is one path of many (`record.create`, MCP, `my.create`). The engine and the orders pipeline are every path |
| **Health answers as fields on the Person or a record** | They would be in `rec_*` views, so in every staff bulk path and the assistant's reads. Stage 43 found the same: keep health data out of the views and give it back only where a person may see it |
| **A signature as a PNG upload** | Arbitrary bytes to parse and check, and to attach; strokes are a small checked JSON document the screens draw as SVG and the PDF draws as lines |
| **Recording the device and internet address** | Decision 3. The record relies on the signed-in account (or the guest's verified payment), the time and the copy sent |
| **Storing the PDF** | A stored file is another copy to erase and to keep right. The PDF is built from the stored version and acceptance whenever it is asked for, so it always says what the database says |

## What is platform work and what is pack work

| Piece | Platform or pack | Why |
| --- | --- | --- |
| Documents, drafts, versions, publishing, effective dates, "small change" or "agree again" | **Platform** (`packages/core/src/agreements/`, core tables) | Decision 1; the wording is evidence and policy |
| The `agreements` behaviour (agreement points) and the admin's attachment of documents to points | **Platform** (SDK contract, reconciler checks) | A pack composes behaviours (ADR 0404) |
| `agreementsDue` and the guard at commit, in the orders pipeline, `startSubscription` and the transition engine | **Platform** | Must hold for every actor and path |
| Acceptances: customer, guardian, guest with an order, staff from paper; immutability | **Platform** | Identity and evidence |
| Signatures, health answers and their isolation; AI exclusion | **Platform** (`agreements/`, `visibility/`) | Health information; policy is not AI-configurable |
| The copy email and the PDF | **Platform** (host mail, the email gatekeeper, a PDF writer) | The attachment rule (ADR 0571) |
| Signing at the desk: the session, its code and token, the `/desk` page | **Platform** (`agreements/`, the host app's public path) | Identity: who is signing, and on whose say-so |
| The minor mark | **Platform** (`agreements/`) | Who may agree for whom is identity |
| Erase, merge, the Trash and keeping records for a period | **Platform** | ADR 0320: erase reaches every store |
| Cooling off: the setting, the cancel and the refund owed | **Platform** (subscriptions) with the **Memberships pack**'s setting | Refunds and subscriptions are core; the period is the gym's setting |
| Points declared on `memberships.plan`, `memberships.passtype`, `bookings.booking`; Ticketing's and Courses' sellables | **Packs** (one declaration each) | Composition |
| Screens: agree, the first sign-in gate, my agreements, a child's; the admin editor, lists and the Person tab | **Base-layer blocks and hooks**, and the host admin | Shared by every pack that has a point |
| The four documents' text | **The business** | The platform ships no legal wording |

## The model

### Words

An **agreement document** (a **document**) is something a business asks people to agree to: its
terms, a waiver, health questions, a parent's consent. Its **kind** is a label (`terms`, `waiver`,
`health`, `guardian`, `other`; `care` is the platform's, for stage 43); only `health` changes how it
works. A **version** is one published wording of it, kept for good. The **current version** is the
one in effect now. An **agreement point** is a place a pack says agreement may be needed (buying a
membership, making a booking); the business **attaches** documents to points. An **acceptance** is
one record that a person agreed to one version: by themselves, by a **guardian** for a dependant,
by a **guest** with their order, or **recorded from paper** by staff. An acceptance is **current**
while it counts for its document (below). A document is **due** for a Person at a point when it is
attached there and they have no current acceptance of it. **Agree again** is a version that makes
every earlier acceptance stop counting; a **small change** does not. The **health form** is a health
document's questions and a person's **health answers**. The **copy** is the email the person is
sent; the **signed PDF** is the same document and record as a file. **Cooling off** is the days in
which a new member may cancel for a full refund.

### Documents and versions (step 1, built: ADR 0640)

- **`core_agreement_document`**: id (`agd_…`), **kind** (fixed when the document is made: only
  `health` changes how it works, so it never changes afterwards), state (`draft`: never published;
  `live`; `retired`: no longer needed anywhere, its acceptances kept; retired is final), the working
  copy (below) and its counter `draft_rev`, the **current version** (the one in effect now; empty
  until the first takes effect), and `agree_from`: the number of the version from which acceptances
  count. The points it is attached to are `core_agreement_point` rows.
- **The working copy** is the draft the editor changes: the title, the body (rich text, ADR 0440's
  schema), the **tick label** (the words beside the box; the business writes them, and a document
  without them cannot be published), **how** a person agrees (`typed`: tick and type their name;
  `drawn`: type their name and draw a signature), **who agrees** (`participant`: the person who
  trains or attends; `payer`: the person who pays), **for whom** (`everyone`, or `dependants`: only
  a Person who is a dependant of a live family link), and for `health` the questions and **ask again
  after** (months; empty for never). Staff with `agreements:manage` edit it; the assistant may write
  it for them (`agreement.draft.save`, an ordinary write through the gate). Editing it changes no
  version and nothing anyone is asked: how, who and for whom are in the working copy, not on the
  document, so even they change only when a person publishes.
- **`core_agreement_version`**: id (`agv_…`), document, number (1, 2, 3), title, body, tick label,
  questions, how, who, for whom, ask again after, **change** (`first`, `small`, `agree_again`),
  **effective from** (an instant), published at and by (a staff user, a person), the working copy's
  `draft_rev` it was made from, and **hash**: SHA-256 of the canonical JSON (keys sorted) of
  **everything the version holds**: the document's kind, title, body, tick label, questions, how,
  who, for whom and ask again after (corrected after the review of PR #266: a hash of the words
  alone let an AI change who agrees or for whom after the person's preview). The database refuses
  any update and any delete of a version, by anyone, host code included, and any insert over an
  existing id (D1 runs without recursive triggers, so `INSERT OR REPLACE` would otherwise get past
  the delete trigger); an insert must match the working copy field by field at commit. SQLite cannot
  hash, so a raw writer could still give a matching row a made-up hash: every read that matters
  recomputes it (`intact`), and step 2's acceptance refuses a version that is not intact. Versions
  are the business's text, not personal data, so nothing ever needs to delete one.
- **What a body may hold**: rich text without `image`, `embed` or `button` blocks (a picture can be
  deleted from the media library later and the hash covers only its id; the copy cannot show the
  others). A link is allowed only when its text is its own address, every rendering shows the
  address in full, and the editor says that a linked page is not part of what a person agrees to.
  Titles, tick labels, questions and body text refuse bidirectional controls (U+202A to U+202E,
  U+2066 to U+2069) and text made only of zero-width characters.
- **Publishing**: `agreement.publish { documentId, change: "small" | "agree_again", effectiveFrom?,
  draftHash, draftRev }` (staff, `agreements:manage`, risk `write`, **`actors: ["human"]`**: the
  assistant, MCP and Code Mode, automations and extension code are refused, not queued). It
  snapshots the working copy into a new version. A first version is `first` whatever `change` says.
  `agreement.publishPreview` returns the exact snapshot (every field), its hash and its
  `draftRev`, and which fields changed against the newest version (every field compared); the
  editor's confirm step renders that snapshot, with the effective date and the kind of change, and
  publishes that hash and rev. A copy changed since in any field, or saved again at all, is refused
  (`conflict`), and the version trigger refuses it in the batch if it changed between the read and
  the commit (`core_agreement_draft_changed`). The publish also names the version **number** the
  preview showed (refused if another publish landed in between), spends the rev in its own batch
  (the same hash and rev never publish twice), and is refused when nothing changed since the newest
  version, so "agree again" never asks anyone to re-agree to unchanged text. The confirm step warns
  when its snapshot is not the copy the editor shows, and shows a changed body's blocks before and
  after, headings at their level and callouts in their tone. A save is compare-and-set on `draft_rev` (two saves of
  one rev never both apply), records its actor, and the editor never swaps in a copy someone else
  saved: it says who changed it (the assistant, an MCP client) and offers to load it, and Publish
  waits while the editor has unsaved edits. (From step 2) the preview says, for "agree again", how
  many people it will ask (those with a current acceptance of the document now).
- **Effective dates**: `effectiveFrom` left out is now. A date in the past is refused (it would make
  the evidence look older than it is), and it may not be earlier than the latest version's, so
  versions take effect in number order. A date in the future schedules it: the minute cron
  (`runAgreementsDue`) makes it current at that time. Before then the earlier version stays current;
  the new one can be read (and, from step 2, accepted early: it counts from when it takes effect, and
  after). **A published version, scheduled or not, cannot be withdrawn**: to replace a scheduled
  wording, publish a newer version taking effect at the same moment; the newest version in effect is
  current, and `agree_from` is the newest `first` or `agree_again` version in effect.
- **Why an AI cannot ask to publish** (unlike ADR 0480): decision 12 says it never publishes, and an
  approval card is a poor place to read a long legal text. A person opens the editor and publishes.
- **Attaching and retiring**: `agreement.attach { documentId, points }`, `agreement.detach
  { documentId, points }` and `agreement.retire { documentId }` (staff, `agreements:manage`,
  `actors: ["human"]`; attach and detach risk `write`, retire `destructive`): what is needed where
  is policy, and loosening it (detaching, retiring) is a person's act. Only a document with a
  version in force is attached (one whose only version is still scheduled is refused,
  `agreement_not_in_force`), and only to a point an installed object declares. Retiring detaches it
  everywhere and freezes its working copy; a version still scheduled is cancelled (it never takes
  effect, the summary no longer shows it as scheduled, and it reads "never in force"). Attaching a
  document makes it due at once for anyone without a current acceptance (it is not retroactive:
  nothing already bought or booked is touched).
- **A point that goes away (for step 3)**: a pack upgrade that renames or drops an agreement point
  must not make a requirement disappear silently. The reconciler's plan names every attached
  document whose point would no longer be declared; the upgrade's review shows it to the admin; and
  when it applies, the attachment is kept (inert, marked "point no longer declared" on the
  document's page and the list) and the counter is bumped in the upgrade's batch, so an admin
  re-attaches it where it now belongs.
- **The counter** `core_agreement_rev` (one row) is step 1's: the host bumps it in the batch of
  every publish, every version the cron makes current, and every attach, detach and retire. That is
  a little more often than strictly needed (a small change asks nobody), on purpose: it also covers
  a version that becomes acceptable early, and a retry is cheap. Step 2's guard reads it; the
  database refuses to lower it or delete it.
- **What an AI does in step 1**: reads documents and versions (titles and text are the business's,
  not personal data), makes a draft document (`agreement.create`) and writes its working copy, each
  through the gate as any write; under a cautious policy that waits for approval and its dry run
  writes nothing. Publish, attach, detach and retire are refused to every AI actor before the gate
  is asked, so nothing of them is ever queued.
- **Languages**: one language per document in this stage. A second language is a later stage.

### When an acceptance is current

An acceptance of document D counts for D while all of these hold:

1. its version's number is at least D's `agree_from` (an "agree again" version moves `agree_from` to
   itself when it takes effect; a small change does not move it);
2. for a `health` document with "ask again after" set, it was made less than that many months ago
   (decided by the host's clock);
3. it is **for** that Person, and for a Person who is a **minor** (a dependant of a live family link,
   or marked as a minor by staff: below), it was made by a guardian with a live link at the time, or
   recorded from paper; never by the minor themselves (decision 20);
4. its Person is not in the Trash.

A newer acceptance of the same document replaces an older one for every purpose; both are kept.

### The `agreements` behaviour: agreement points (the declaration built in step 1: ADR 0641)

An object declares where agreement may be needed (SDK and contract; shipped and reviewed packs, as
`sellable` is). In step 1 the declaration is inert: it is checked and listed (`agreement.points`),
and documents can be attached to it, but nothing asks it until step 3:

```ts
agreements: {
  point: "membership",            // the point's name; one object may share a point with another
  label: "Starting a membership",  // what the admin shows when attaching documents
  suggests?: ["terms", "waiver", "health", "guardian"],  // kinds the admin offers first
  // A record made by a caller (a booking): checked when it enters these states, for this Person.
  enter?: ["booked", "waiting"],
  person?: "person",
}
```

- **On a sellable object** (a membership plan, a pass type, a ticket type, a course): checked when
  an order or a subscription with it starts. `participant` documents are checked for the **holder**
  (who it is for), `payer` documents for the **payer** (who pays; ADR 0487). In this stage they are
  the same Person except where staff name another holder.
- **On a record made by a caller** (`enter`, `person`): checked by the transition engine when a
  caller creates the record in, or moves it into, one of the listed states: a booking made booked or
  waiting, and a waiter taking a free place themselves. **The host's own moves are not checked**
  (promotion from a waitlist, a drop-in booked by its payment, a timed move): a waiter agreed when
  they joined, and decision 7 is not retroactive.
- **The first client's points**: `memberships.plan` and `memberships.passtype` share the point
  `membership` ("buying a membership or a pass"); `bookings.booking` has `booking` ("before a
  booking", `enter: ["booked", "waiting"]`). The business attaches: terms to `membership`; the
  waiver, the health form and the guardian consent to both.
- **Ticketing and Courses** declare points on their sellables (`ticketing.tickettype`: `event`;
  `courses.course`, `courses.bundle` and `courses.plan`: `course`) with `suggests: ["waiver"]` and
  `["terms"]`. **Nothing is attached to them by default**, so selling a ticket or a course is
  unchanged until a business attaches a document. A ticket's buyer agrees for themselves; a waiver
  per named attendee waits for named attendees (out of scope).
- **Stage 43's care link** has a platform point, `care` (below).
- **Checks the contract makes**: the point's name is a word; `enter` names states of the object's
  `states`; `person` is a relation to one Person; an object with `enter` is not also checked at an
  order unless it is sellable (a drop-in booking is both: the order's check covers it, below).

### The one question: `agreementsDue`, and the guard at commit

`packages/core/src/agreements/due.ts` is the one place that answers it:

```ts
agreementsDue(db, {
  point: string,
  participant: string | null,  // the Person it is for
  payer: string | null,        // the Person who pays (null for a record that is not bought)
  guest?: GuestAcceptances,    // a visitor's acceptances carried with their order (below)
  now: string,
}): Promise<{ rev: number; due: DueDocument[] }>
```

- It reads the documents attached to the point that are `live` and current, works out each one's
  Person (participant or payer; `dependants` documents only when the participant is a live
  dependant), and returns those with no current acceptance, each with its current version (and any
  scheduled one).
- **Where it is asked**, always in the host and always before the write's batch is planned:
  `createOrder` (every order: `order.start`, `order.startHeld`), `startSubscription` (a continuation
  offer included), and the transition engine's create and move checks beside its windows and
  `closed` flag (`records/states.ts`). A caller that does not hold what is due is refused with
  `invalid_input`, `rule: "agreements_due"`, and the list of due documents by id and title: for a
  customer only their own and their dependants', for a guest only the documents (never whether the
  address has agreed before), for staff the Person's.
- **The guard**: every batch that relied on the answer carries one row, `core_write_guard` of a new
  kind `agreements` with the `rev` read. `core_agreement_rev` is one counter the host bumps in the
  batch of every change to what is due (built in step 1, above): every publish, a scheduled version
  made current by the cron, a document attached, detached or retired. If
  it moved between the read and the commit, the trigger aborts (`core_agreements_changed`), the whole
  batch fails and the caller is told to look again (`conflict`). So a document published with "agree
  again" a moment before a booking commits cannot be booked past. The counter is coarse on purpose:
  documents change a few times a year, and a retry is cheap.
- **Acceptances in the same batch**: a guest's acceptances, carried with their order, are inserted
  in the order's batch, so the check and the record commit together.
- **What it never does**: it never cancels a booking, ends a membership or refuses a provider's
  charge. "Agree again" blocks the next booking and the next purchase, nothing that already exists
  (decision 7).

### How a person agrees

All acceptances go through `packages/core/src/agreements/accept.ts`, which checks the version, the
capture and who may agree, and queues the row, the signature, the answers, the copy and the guard in
the caller's batch. The version accepted must be current or scheduled at commit (the guard covers
it).

| Path | Operation | Who | Recorded as |
| --- | --- | --- | --- |
| **A signed-in customer** for themselves | `me.agreements.accept { versionId, typedName, signature?, answers? }` (customer, write; an open operation, a reviewed change) | The customer | `by: "self"`, the customer account, channel `web` or `app` |
| **A guardian for a dependant** (decision 9) | the same, with `forPersonId` | A customer with a live family link to that Person; the write carries `core_person_link_guard` | `by: "guardian"`, the guardian's Person and account, for the dependant |
| **A visitor with no account** (a drop-in, a pass, a ticket bought as a guest) | the acceptances go in the buying call: `order.start`'s and `order.startHeld`'s `agreements` input (passed on by `x.bookings.buy`), and `subscription.start`'s for a guest | The public | `by: "guest"`, the order (or the subscription checkout) and its address; no Person until settlement |
| **Staff from paper** (decision 10) | `agreement.recordPaper { personId, versionId, signedOn, forPersonId?, signedBy?, note?, answers? }` (staff, `agreements:paper`, `actors: ["human"]`) | A person on the staff | `by: "paper"`, the staff user who recorded it, when they recorded it and the date written on the form |
| **In person on the business's device** (decision 22) | `desk.accept` in a desk signing session a person on the staff started (below) | The member (or their guardian) themselves, on the desk tablet | `by: "self"` or `"guardian"`, channel `desk`, the desk session, which names the staff account that started it and when |

- **A guest's acceptances become the Person's at settlement.** The verified payment that matches the
  order's address to a Person (ADR 0428, ADR 0560) sets the acceptances' Person in its own batch.
  Several matches: when staff settle the order (`order.setPerson`). An order that expires or is
  cancelled unpaid deletes its guest acceptances in that batch: no contract was made, and they are
  nobody's personal data to keep. A guest who is already a member and has agreed is asked again, the
  same as anyone, so the answer says nothing about who has the address.
- **Staff cannot agree for someone.** Staff starting a membership, selling a pass or booking a class
  for a Person who has something due are refused with the list, and offered three things: **send a
  link** (the host emails the Person, or their guardians for a dependant, a link to agree; a host
  mail like the copy), **sign at the desk** (below) and **record a paper form**. Paper is shown
  everywhere as "Recorded from paper by [staff name] on [date]", never as the member's own
  acceptance; a desk acceptance as "Agreed in person on [business]'s device; session started by
  [staff name] at [time]".
- **Paper forms** are printed from the version (a blank PDF of it, with its number and hash at the
  foot, from the document's page), so the paper matches a version the host holds. Staff may type in a
  paper health form's answers; they are marked as entered by staff.
- **The assistant and MCP** cannot accept for anyone: the accept operations are open to customers and
  the public only, and `recordPaper` is a person's.

### The acceptance record

`core_agreement_acceptance`:

| Field | What |
| --- | --- |
| `id` | `aga_…` |
| `document_id`, `version_id`, `shown_hash` | What was shown: the version, and the hash of what the screen showed (the version's hash; for a care consent, with its filled-in values, below) |
| `context` | Filled-in values shown with the version (only the care link's in this stage), JSON, or null |
| `person_id` | Whom it is for. Null only for a guest's acceptance before settlement |
| `by` | `self`, `guardian`, `guest`, `paper` |
| `agent_person_id`, `account_id` | Who agreed: the guardian's Person and customer account, or the customer's own account; null for a guest and for paper |
| `order_id`, `subscription_checkout` | What a guest's acceptance was taken with |
| `email` | The address the copy goes to: the account's sign-in address, the guest's order address, the address the desk session sent it to, or null for paper |
| `how` | `typed`, `drawn`, `paper` |
| `typed_name` | The name typed (1 to 200 characters, no control characters). For paper, the name staff read on the form |
| `channel` | `web`, `app`, `paper`, `desk` |
| `desk_session_id` | Desk only: the desk signing session (`core_agreement_desk_session`), which holds the staff account that started it, when, and when the device claimed it |
| `accepted_at` | The host's clock at commit |
| `signed_on`, `recorded_by`, `note` | Paper only: the date on the form, the staff user who recorded it, an optional note |

- **Nobody can change it.** A trigger refuses every update except two, both host code in one module:
  setting `person_id` where it was null (settlement) or from a merged Person to the survivor (merge),
  and clearing identity columns to null under the retention rule (below). Nothing sets a value back.
  No operation updates an acceptance; the only delete is erase's or the retention purge's.
- **Not a record.** It is in no `rec_*` view, so not in `query.sql`, dashboards, exports, search,
  embeddings or summaries. Staff read it through `agreement.acceptances` operations, on screen.
- **The typed name is not checked against the Person's name.** A different name is shown beside the
  Person's on the staff side.
- **The copy's sending** is kept beside it (`core_agreement_copy`: to, queued, sent or failed, when),
  so the acceptance itself never changes.

### Drawn signatures

- **Strokes, not an image**: a document `{ width, height, strokes: [[x, y], …][] }` in a 1000 × 400
  box, integer points, at most 30 strokes and 5,000 points, at most 32 KB. Refused: empty, a dot, or a
  signature shorter than a set length (the block says "draw your signature"). Checked like every
  document field, on every write.
- **Kept in its own table** (`core_agreement_signature`, keyed by the acceptance), so it is read only
  where it is shown (the person's own view, the staff Person tab, the PDF) and erased on its own.
- **Personal data**: never to an AI actor, never in an error or an audit value (field names only).
- **Screens** draw it as SVG; the PDF draws it as lines. The native block captures it with the touch
  responder the app already has; no new native module.

### Health questions (decision 5)

- **The form** is part of a `health` document's version: up to 40 questions, each a key, the text,
  yes or no, and whether a "yes" asks for a note (up to 1,000 characters). The person answers every
  question, types their name and agrees: the answers and the agreement are one acceptance.
- **Where answers live**: `core_agreement_answer` (the acceptance, the answers as JSON, and `any_yes`).
  Not in any `rec_*` view, not searchable, not embedded, not summarised, not in exports, the digest,
  the timeline, the Trash or audit values (field names only; ADR 0019's redaction applied at write).
  Errors never carry them.
- **Who reads them**:
  - the person (and a guardian, for a dependant), in "My agreements";
  - **staff with `agreements:health`** (a new permission: admins by default, grantable one by one,
    ADR 0449), a person only (`actors: ["human"]`), on the Person page behind "Show answers"; each
    read writes an audit row naming who read whose answers (no values);
  - **coaches on a class list see a mark only** (decision 18): "health note" beside the name of a
    Person whose current health acceptance has a "yes", with no question, answer or note. The coach
    role (ADR 0436) gains that one read, a yes-or-no per Person on the list; issue #258 reshapes
    roles anyway. Staff with `agreements:health` open the answers from the Person page;
  - **never an AI actor** (the assistant, MCP, an automation's AI step), whatever is granted. No
    setting turns it on;
  - **never a practitioner** (stage 43): a practitioner sees only their own work.
- **A "yes"**: staff with `agreements:health` are told in the host ("[name] answered yes to a health
  question"); an email or push says only "a member's health form needs a look: open the app". It
  does not block booking (decision 19): the member books straight away, and what a "yes" needs (a
  doctor's clearance) is the business's process with its insurer, not the app's.
- **Asked again**: after the document's "ask again after" (default 12 months, a guess), the
  acceptance stops being current and the next booking asks for it. A person may also update their
  answers at any time (a new acceptance).
- **Relation to stage 43's restrictions**: a restriction is a practitioner's instruction to the
  coach; a health answer is the member's own report. They are separate, shown on separate tabs, and
  neither feeds the other.

### The copy and the signed PDF

- **The copy is the host's own mail**, sent after the acceptance commits: one recipient (the
  acceptance's `email`); subject "[business]: your copy of [document]"; a short fixed body (what was
  agreed, when, how, how to see it in the app), and the signed PDF attached. It goes through
  `callAsHost` with a new purpose, `agreements`, the way an order's confirmation does (purpose
  `orders`): a message the host composed from a fixed template applies at once unless the deploy-time
  floor denies it. So **it needs nothing from the routine-mail work** (the owner's decision of
  2026-11-23 that a pack's fixed routine emails send without approval, being built on
  `feat/routine-mail` and not yet on `main`): that is about a pack's emails, and the copy is the
  host's own. If routine mail, once merged, gives the host a general "fixed template the host
  composes" path, step 4 uses it instead; the rule is the same. The copy is not an automation run,
  so the runs-per-minute rail and its deferred runs (ADR 0573) do not shape it. A guardian is sent
  the copy of what they agreed for their child. Paper
  acceptances send no copy unless staff press "Email a copy" (and the Person has an address).
- **The copy carries an idempotency key** (ADR 0574), `agreement-copy:<acceptance id>`, so a retried
  send of the same copy goes once (step 4 passes it through `callAsHost` to the gatekeeper's `send`).
- **Health answers are not in the email** (decision 21): the PDF attached to a health
  form's copy lists the questions and says "your answers are in the app". The PDF downloaded in the
  app, and by staff with `agreements:health`, includes them.
- **What the PDF says**: the business's name, the document's title and version number, the body as
  the version holds it (headings, paragraphs, lists, quotes; a picture is left out and named), the
  tick label, and the record: for whom, who agreed and how, the typed name, the signature drawn, the
  time in the deployment's zone and in UTC, the version's hash and the acceptance's id. A paper one
  says "Recorded from paper by [staff] on [date]; signed on [date]".
- **How it is made on Workers.** Three ways were weighed:

  | Option | Feasible? | Verdict |
  | --- | --- | --- |
  | **A PDF writer in TypeScript** (a small one of our own, or a vendored pure-JS library such as `pdf-lib`, MIT), run by the email gatekeeper for the attachment and by the host for downloads | Yes: no Node APIs, no browser. Standard PDF fonts cover Latin text (WinAnsi); other scripts need an embedded font, which one language per document lets us leave for later | **Recommended** |
  | **Cloudflare Browser Rendering** (headless Chrome, HTML to PDF) | Yes, with a binding, a paid plan and per-account browser limits; a page is rendered by a browser the host drives | Rejected for now: a new service on every deployment, and the email gatekeeper would wait on a browser |
  | **A print-ready HTML page** and the browser's own "Save as PDF" | Yes for a person downloading; not for an email attachment | Kept as well: the acceptance's page prints cleanly, at no cost |

- **The attachment is the gatekeeper's, from checked values (an amendment to ADR 0571).** A message
  may carry `agreement` beside `calendar`: the business's name, the title, version number and hash,
  the body as rich text (ADR 0440's schema, checked again), the tick label, the record lines, the
  questions (and, only where the host asked, the answers), and the strokes. The gatekeeper builds the
  PDF when the send is applied, attaches it as `agreement.pdf`, and the approval card (if the floor
  ever sends one to review) shows "Signed agreement: [title], version [n], [who], [when]". Nothing
  else can be attached; a message with an agreement is never sign-in mail. The same writer module is
  used by the host's download route, so the two files are the same.
- **Downloads**: `me.agreements.pdf { acceptanceId }` (customer, their own and their dependants'),
  `agreement.acceptance.pdf { acceptanceId }` (staff; with answers only for `agreements:health`), and
  `agreement.version.pdf { versionId }` (staff: the blank, for paper). Built on demand, never stored.

### Cooling off (decision 11)

- **The setting**: `coolingOffDays` on the Memberships pack (Settings → Extensions → Memberships), a
  whole number, 0 off (the default), `personApproves`. One setting for every plan.
- **Who may use it** (decision 17): the holder's subscription to a membership plan started here by
  `subscription.start` without a continuation offer (a new member; not a member moving over, and not
  a pass), within that many days of the provider-confirmed start (the host's clock).
- **The cancel**: `subscription.coolOff { id }` (customer, for their own as payer; staff with
  `subscriptions:manage`, a person only). It ends the subscription at once with the provider (as a
  cancel now does), and in the batch that follows the provider's verified event it writes a **refund
  owed** (`core_sellable_refund_due`) for every paid period order of that subscription, in full. The
  minute cron asks the payments gatekeeper; each refund waits for a person with `orders:refund`,
  like every refund (ADR 0429). A rejected or lapsed one tells staff, as ADR 0560's do.
- **A free trial longer than the period** leaves nothing to refund; the button says "cancel" and the
  trial ends as any trial does.
- **Uses already spent**: a full refund whatever was used (decision 16). Bookings ahead,
  and what the ended membership gives, follow what a membership ended at once does today (stage
  32b).
- **The words** that tell a member about cooling off are the business's, in its terms. The app shows
  "You can cancel for a full refund until [date]" beside the cancel button while it applies.
- **Passes**: not covered (decision 17).

### Members moving over (decision 8)

- **What a moved member has**: their Person (imported, stage 33 or `cos memberships import`, 32b step
  8), perhaps a continuation offer (ADR 0491) or a membership moved with its card (stage 33), perhaps
  future bookings moved over. **No acceptances**: an old system's records are not evidence of these
  versions, and decision 8 says they agree afresh.
- **The first sign-in**: the app and the website ask `me.agreements.due` after sign-in, and show
  **"Before you go on"**: each due document in turn (for themselves, then for each dependant), with a
  way to skip to their account. The screen is only a convenience; the host enforces.
- **What they can do before agreeing**: sign in, read their records (membership, passes, bookings,
  agreements), change their details, cancel a booking, cancel their membership, open the provider's
  portal. Nothing that needs agreement: book, join a waitlist, buy, or **take their continuation
  offer**, which is a subscription start and so needs the membership terms. So the first charge on
  the new system, the continuation's first period, always follows an acceptance.
- **A membership moved with its card** (stage 33's option): the provider charges it on the old
  authority, and the host does not and cannot stop that charge. Staff see "moved members who have
  not agreed yet" and can send each a link. Whether that is enough is on the list for the lawyer.
- **Bookings moved over** stay booked (not retroactive); the member's next booking asks.

### Children (decision 9)

- **A dependant** is a Person with a live family link (ADR 0540). `dependants` documents (the
  guardian consent) are due only for them; every other document attached to a point is due for them
  too (the waiver, the health form), and for a dependant only a guardian's acceptance or a paper one
  counts (decision 20).
- **A minor** is a dependant, or a Person staff have **marked as a minor**. The host holds no date of
  birth, and a teenager may have their own sign-in and no family link yet, so the mark is how the
  host knows. It is `core_agreement_minor` (the Person, who set it, when; one row or none), set and
  cleared by `agreement.setMinor { personId, minor }` (staff, `people:link`, `actors: ["human"]`:
  who may agree for whom is identity, as the family link is). Staff clear it when the person comes
  of age; the host never works out an age. **What it gates**, and nothing else: for a minor, every
  attached document is due as for a dependant (the `dependants` documents included); their own
  acceptance is refused when they try (signed in, or at the desk for themselves: "a parent or
  guardian agrees for you"), and only a guardian's with a live link, or paper, counts. A marked
  minor with no linked guardian cannot book or buy until staff link one or record paper; the Person
  page says so. The mark is in no `rec_*` view; erase deletes it, and a merge keeps it if either
  Person had it.
- **A guardian agrees for each child**, one acceptance each, from "My family" or when booking for the
  child: the host checks the link is live (`core_person_link_guard` in the batch). The guardian
  receives the copy. Ending the link later does not undo what they agreed; another guardian may
  agree again.
- **Staff record a paper form** for a child, naming who signed it (`signedBy`, free text: "mother,
  [name]").
- **A child with no link and no mark** is treated as an adult by the host. Staff link the parent
  first, or mark the Person a minor; the admin's child view says so.

### Signing at the desk (decision 22)

The member signs on the business's own tablet at the front desk, as their own acceptance: not a
paper form staff type in, and not staff agreeing for them.

**Whose sign-in the device runs under: none, on an enrolled device.** Two things together open a
session, and neither does anything alone:

1. **The device is enrolled** once, as the business's own. The tablet holds a device credential and
   nothing else: no staff sign-in, no member's sign-in.
2. **A person on the staff**, signed in on their own account (the desk computer, their phone),
   starts a **desk signing session** for one named Person. The host answers with a short one-time
   **code**, which is typed on the enrolled tablet (or the tablet scans the QR the staff screen
   shows).

Weighed and rejected:

| Option | Why not |
| --- | --- |
| **A kiosk account** (a standing "front desk" sign-in on the tablet that can open anyone's documents) | Standing authority on a shared device: signed in all day, it reaches every member's documents, and whoever picks it up holds it. Nobody is accountable for a given session |
| **Staff hand over their own signed-in device** with a locked screen | The browser still holds a staff credential: a screen lock is the client deciding, and a member with the URL bar (or a reload) reaches staff screens. A lock enforced in the host would need sign-in to be undone on the device, which most desks would turn off |
| **A code alone on a public page** (the first draft of this design) | Nothing bound the session to the business's device: anyone who saw the code or the QR could claim it on their own phone, see the names and the due documents and sign as the member, while the record said "on the business's device" (the review of PR #266) |
| **The member's own phone only** (the spec's first recommendation) | Kept (staff still send a link), but the owner wants the desk too: a visitor without their phone, or a parent with a child |

**Enrolling a tablet** (`core_agreement_desk_device`, `adv_…`):

- **Enrolment is an admin's act**, separate from starting sessions: `agreement.desk.enrol { name }`
  needs the admin role, a person (`actors: ["human"]`), and no grant can give it. The review of
  PR #266 showed why: anyone able to enrol could enrol their own phone as "the front desk" (a
  private window gets past any staff-session check), and the record would call it the business's
  device.
  - The admin names the tablet ("Front desk iPad") on their own signed-in device. The host answers
    an enrolment code: 10 characters, single use, valid 10 minutes, stored only as an HMAC under a
    server-side secret.
  - On the tablet the code is typed at the desk origin's `/enrol` (below). The host then sets the
    **device credential**: 256 random bits in a cookie, stored only as its HMAC.
  - **Every admin is told** at once, in the host and by email: "[admin] enrolled a desk tablet,
    [name], at [time]".
- **What the device row records**: its name, who enrolled it and when, when it was last seen, and
  when and by whom it was revoked. It also records the browser (its user agent) and the network
  address at enrolment and at each claim. A claim from a different browser or network than the
  last is flagged on the devices list.
  - **This does not go against decision 3.** Decision 3 records no device or address for an
    ordinary acceptance because those are the *member's* device and connection, which are personal
    data and add little. Here the device is the *business's own*: its browser and network describe
    the business's tablet and premises, and are what show a phone posing as it.
- **What the credential can do alone: nothing.** It shows the "Enter code" screen and lets the
  tablet make `desk.claim`. It reads no Person, no document and no session.
- **Rotation.** Every claim replaces the credential with a new one in the same response.
  - **A lost response** does not lock the tablet out: for 60 seconds a claim is idempotent on (the
    old credential, the code), so the tablet's retry gets the same new credential and token.
  - **A clone**: a credential already rotated away and presented outside that window means two
    browsers hold it. The host revokes the device, ends its session, and tells every admin.
  - A credential not used for 30 days lapses, and an admin enrols the tablet again.
- **Loss or theft.** Settings → Agreements → Desk tablets lists each device with when it was last
  seen, its flags and its lock-outs. `agreement.desk.revoke { deviceId }` (an admin, a person)
  revokes it at once and ends any open session on it in the same batch. A lost tablet holds no
  member's data, and once revoked it opens nothing.

**The desk session** (`core_agreement_desk_session`, `ads_…`):

- **Who may start one.** At the first client the people at the desk are coaches, and an account
  with a pack role holds only permissions a pack declares grantable (ADR 0600). So core declares a
  very small set of its own permissions **grantable to a fixed-role account**: in this stage only
  `agreements:desk`, each one justified in the ADR.
  - It lets a person start a session for a named Person on a device an admin already enrolled.
  - It shows the titles of what that Person has due, and nothing of their record beyond that.
  - It records no acceptance itself: the member signs.
  - Enrolment and revocation stay admin-only. (ADR 0600 is amended at build.)
- **Starting it**: `agreement.desk.start { personId, deviceId, dependantIds? }` (staff,
  `agreements:desk`, `actors: ["human"]`, risk `write`).
  - It names the Person who will sign, the enrolled device it will be signed on, and for a parent,
    which of their live dependants they will sign for (each must be a live link now).
  - It records the session: the Person, the dependants, the device, the staff user who started it,
    when, and the address the copies will go to.
  - It answers the code: 8 characters from an unambiguous alphabet, single use, valid for 2 minutes
    until claimed, stored only as an HMAC-SHA-256 under a server-side secret (an env secret, like
    every auth secret).
  - Refused: a Person in the Trash; a Person marked minor signing for themselves (decision 20:
    start it for their guardian); a signer with no email address (below); a revoked device.
- **Claiming it**: `desk.claim { code }` (public audience, on the desk origin only) needs:
  - an enrolled, unrevoked device credential;
  - a code of a session not yet claimed.

  It binds the session to that device and answers a session token (256 random bits, stored as its
  HMAC) in its own cookie.
  - **Wrong codes**: five from one device in a minute lock it out for five minutes.
  - **Claim races**: a claim from a device other than the one staff chose ends the session at
    once, and so does a failed claim on the expected device. Both are refused, and the staff
    member is told on their screen. The staff screen shows which device claimed the session, and
    when.
  - **One session per device**: a claim on a device ends any session already open on it, on the
    server, in the claim's batch.
- **Signing**: `desk.documents` and `desk.accept { versionId, forPersonId?, typedName, signature?,
  answers? }` (public audience, through `accept.ts` as every acceptance). They need the session
  token **and** the device credential it was bound to. They serve only the documents **due** for the
  session's Person (and its listed dependants) at that moment, their current versions, and nothing
  else. All the desk calls are reviewed additions to open-operations.json.
- **Ending it**: `desk.finish` (the tablet, "All done") and `agreement.desk.end { sessionId }`
  (staff) end it at once.

**Its own origin, cookies and what the token may do.**

- **The desk is served from its own origin** (a hostname of its own for the same host Worker, set
  up with the deployment: `desk.` before the host's name). The host serves only the desk pages and
  the desk calls there, and serves no desk page on the staff origin.
  - So no script on the staff origin (a pack's web block, an extension's screen, a compromised
    dependency) can frame the desk, read its DOM or send requests that carry its cookies.
  - A deployment that cannot add the hostname has no desk mode. It does not fall back to the staff
    origin.
- **Both cookies** are `HttpOnly`, `Secure` and `SameSite=Strict`, on the desk origin only, and never
  in a URL or shown.
- **A cookie path is not a security boundary**, and the design does not rely on one. Two things
  keep the token apart:
  - **its server-side scope**: a desk token is read by exactly five calls (`desk.claim`,
    `desk.documents`, `desk.accept`, `desk.heartbeat` and `desk.finish`), each on that one session
    and device. Every other operation, route and the HTTP surface ignore it, and a staff call never
    accepts it;
  - **the origin it lives on**.
- **Every desk write** checks that `Origin` is the desk origin, and refuses otherwise.
- A desk call that arrives with a staff session is refused as a matter of hygiene. This does
  **not** stop a staff member using their own machine (a private window has no staff session). What
  stops a phone or a staff laptop posing as the desk is enrolment: an admin's act, announced to
  every admin, and bound to a browser and network.

**Limits the host enforces, not the page.** The session row holds `claimed_at` and
`last_activity_at`. Every desk call is refused, and the session ended on the server, when either
limit has passed:

- **Idle**: 3 minutes since the last activity.
- **Total**: 20 minutes since the claim.

A new claim on the device ends the old session on the server, and an ended or expired token
answers nothing.

- **Reading counts as activity**: a member reading a long document is not timed out. The page sends
  `desk.heartbeat` while the person touches or scrolls, at most every 30 seconds.
- **The host bounds the heartbeat**: a heartbeat less than 20 seconds after the last one does not
  extend the session, so a script beating faster gains nothing, and no heartbeat passes the
  20-minute total.
- **The page's own timers** only clear the screen sooner.

**What the tablet can and cannot show or do.**

- **What it shows**: the business's name, "Documents for [given name]" (and each listed child's
  given name), each due document's text, the health form, the tick label and box, the typed name
  and the signature pad. Then "All done: please hand the device back", which shows nothing more.
- **What it never shows**: no other member's data, and none of this member's other data. No
  membership, bookings, history, earlier answers, or address (the copy line says "a copy goes to
  s•••@e•••.com").
- **No navigation**: the desk origin serves nothing else.
- **After a health form is submitted** nothing of its answers is shown again.

**How the acceptance is recorded, as honest evidence.**

- **The record**: `by: "self"` (or `"guardian"` for a child), `channel: "desk"`, `how` typed or drawn
  as the document says, and `desk_session_id`. The session names the staff account that started it
  and when, the device it was claimed on, and when it was claimed.
- **How it is shown**: on every screen and in the PDF it says exactly what the record holds, and no
  more: "Agreed at the desk on the device enrolled as [name] by [admin] on [date]; session started by
  [staff] at [time]". It does not say "in person": the host cannot know who held the device. It is
  distinct from paper ("staff recorded a paper form").
- **No account**: no customer account is involved, so `account_id` is null.

**A parent for a child at the desk.** Staff start the session for the parent, listing the children;
the parent agrees for each (`forPersonId`), recorded `by: "guardian"` with the parent as
`agent_person_id`; the batch carries `core_person_link_guard`, so a link ended meanwhile fails it.
Their own due documents come first.

**A drawn signature on a tablet.** The same signature pad as the web Agree block (pointer events,
finger or stylus), the same strokes format and limits; nothing native.

**A visitor with no account yet.** Staff create the Person first (`person.create`, as the desk does
today) with an email address, then start the session. Desk signing makes no customer account.

**Abuse: staff signing for a member.** Said plainly: **the emailed copy is the deterrent against
staff signing for a member, not proof that the member was there.** The design makes misuse costly
and visible. It cannot prove presence.

- **The copy is emailed every time**, to the signer's own address. The copy goes to the customer
  account's verified sign-in address when the Person has an account, otherwise to the Person's
  primary email. A signer with no address cannot sign at the desk (they sign on paper or on their
  own phone).
  - **What the copy says, and no more**: "Version [n] of [document] was accepted for you at
    [business]'s desk, on the device enrolled as [name], in a session started by [staff] at [time].
    If this was not you, reply or tell [business]." The PDF carries the same lines. Neither claims
    the email proves who signed.
- **Addresses are compared by mailbox**: case folded and a plus-tag removed. Dots are folded only
  where the platform's existing address normalisation already folds them, and nowhere else.
- **The address is pinned at start** and kept on the session. The **marks** (below) are shown on
  the acceptance in the Acceptances list and on the Person's tab. They are marks, not alerts:
  nobody is notified, so a busy desk's walk-ins do not become noise.
  - **Changed recently**: the Person's primary address changed in the 30 days before the signing,
    or changes in the 30 days after. Every path that changes it counts: a staff edit, adding a
    second address and making it primary, a merge, an import, and the customer's own change. The
    list works this out when it is read, from the audit, so a change made, signed under and changed
    back is still caught. The mark says who changed the address and how.
  - **Created that day**: a Person created within 24 hours of the signing (a walk-in). This mark is
    expected and common.
  - **Staff's own address**: the mailbox is also a staff account's.

  When the address changed in the 30 days before, **the copy also goes to the previous address**.
- **Every session names its staff account and device.** The Acceptances list filters by "at the
  desk", by mark, by device and by who started them, so one account's pattern is visible to an
  admin.
- **It is weaker evidence than a signed-in acceptance**, and the PDF says how it was made. Whether
  that is enough is on the list for the lawyer.

**Native**: not needed. The tablet runs the desk origin's page in its browser at tablet width (a
base-layer web block). The business may also pin the browser with the tablet's own guided-access
mode; the design does not rely on it.

**The AI**: never. Enrolling and revoking are an admin's, starting and ending a person's
(`actors: ["human"]`), and the desk calls are public, open only to an enrolled device holding a
claimed token.

### Stage 43: the care link's consent becomes an acceptance

- **The consent is an acceptance of a `care` document.** The platform adds one document of kind `care`
  to every deployment when stage 43 is installed, with the business's own text as its body (decision:
  no legal wording from the platform). The **facts** stage 43 must show (who the practitioner is,
  what they and the coaches will and will not see, where the data is stored, how to end it) are
  filled in by the host as the acceptance's `context`, shown above the business's text, and covered
  by `shown_hash`. These are descriptions of what the system does, not legal terms.
- **The care link points at its acceptance** (`core_care_link.consent_acceptance_id`) instead of its
  own consent columns. `me.care.consent` records the acceptance (`by: "self"`, the customer account,
  the channel) and makes the link live in the same batch. The document's how is `typed` by default.
- **Its point is `care`**: due on every consent (each link is its own acceptance, because the
  practitioner is part of what was shown). "Agree again" on the `care` document does not end live
  links (not retroactive); it applies to new ones.
- **Erase and merge** of care links follow stage 43; their acceptances follow this stage's rule.
- **What stage 43's build waits for**: its step 4 (the care link and consent) needs this stage's
  steps 1 and 2 (documents, versions and acceptances). If stage 43 gets there first, it writes its
  consent through a narrow function with the same fields (`recordConsent(link, shownText, hash,
  account, channel)`) that step 2 here replaces, with a migration that copies the rows across. Its
  steps 1 to 3 need nothing from here.

### Erase, merge, the Trash and keeping records

Acceptances are evidence a business may need for years (a claim can come long after) and personal
data a person may ask to have erased. Decided (decision 15):

- **Erase** deletes at once the Person's **health answers** (all of them; the most sensitive data,
  and not evidence of the contract), any guest acceptances on their unpaid orders, their minor mark
  and any open desk session for them (a closed session stays with the acceptances it made, detached
  like them). It **keeps** the
  rest of each acceptance (the version, when, how, the typed name, the address, the signature),
  detached from the deleted Person and marked `erased`, until the retention period ends, then the
  purge deletes it. The erase screen says what is kept and until when.
- **The retention period** is a setting (`keepAcceptancesYears`, default 7, a guess; a human admin's
  choice, `personApproves`), counted from the erase.
- **Who can read a kept acceptance** after erase: staff with `agreements:manage`, found by the
  address or the name it holds, for a dispute or a claim. Nothing else lists it.
- **Merge** re-points acceptances (and acceptances made as a guardian) to the survivor in the merge's
  batch; the survivor's current acceptances are the best of both; nothing in an acceptance changes.
  The merge preview counts them.
- **The Trash**: a Person in the Trash has no current acceptance (nothing can be bought or booked for
  them anyway); restored, their acceptances count again. Acceptances never appear in the Trash list.
- **Documents and versions** are the business's text, not personal data: never erased; a document
  with acceptances can be retired, not deleted.
- **Erase reaches every store** (ADR 0320): the copy's queued email, if it has not gone, is scrubbed
  with the others (issue #259 notes this is unverified for queued sends generally).

### What an AI may do

| Act | The assistant, MCP clients, automations |
| --- | --- |
| Draft a document's working copy | Yes, for a staff account with `agreements:manage`, through the gate as any write |
| Publish, schedule, attach, detach, retire | **Never** (`actors: ["human"]`, refused, not queued) |
| Accept for anyone, record paper | **Never** |
| Read whether a Person has what is due ("why can't Sam book?") | Yes: document titles and dates, never names typed, signatures or answers |
| Read health answers, signatures, the PDF | **Never** |
| Start or end a desk session, mark a Person a minor | **Never** (`actors: ["human"]`) |
| Start an order, a subscription or a booking for someone | Only as today, and refused like anyone when something is due |

### Screens

| Where | Who | What |
| --- | --- | --- |
| Web and native: **Agree** (a block) | Customer, guardian | The document (rich text, rendered by the client), the health form if any, the tick label and box, the typed name, the signature pad for `drawn`; "Agree"; then "a copy is on its way to [address]" |
| Web and native: **Before you go on** | Customer | After sign-in when anything is due: each document in turn, for them and each child; "Not now" goes to their account |
| Web: **checkout step** in the drop-in and pass blocks; web and native: **booking** | Visitor, customer | What is due at this point, inline, before "Pay" or "Book"; a visitor's acceptances go with the buying call |
| Web and native: **My agreements** | Customer | Each document: what they agreed to and when, the version, "agree again" notices, the PDF; update health answers; a child's, for a guardian |
| Host admin: **Settings → Agreements** | Staff with `agreements:manage` | Documents with kind, state, current version, points, how many people have it due; new document |
| Host admin: **Document editor** | Staff with `agreements:manage` | Title, kind, how, who agrees, for whom, tick label, the body (stage 28's rich text editor block), the health questions, ask-again months, points; preview as a member sees it; **Publish** (small change or agree again, now or from a date, the change against the current version, how many it asks); versions (read only, each with its acceptances count, the blank PDF) |
| Host admin: **Acceptances** | Staff | By document, version, how (paper marked), date; **Due**: who still needs which document (members with a live membership or a booking ahead first), with "send a link" |
| Host admin: **Person page → Agreements tab** | Staff | Each document attached anywhere: current, due or agree again; history; the PDF; **Record paper**; **Send a link**; health answers behind "Show answers" (`agreements:health`, audited) |
| Host admin: **Memberships settings** | Staff (a person) | Cooling-off days |
| Coach's class list (Bookings) | Coach | "Health note" beside a name with a health "yes", no content (decision 18) |
| Host admin: **Person page → Sign at the desk** | Staff with `agreements:desk` | Choose the children (for a parent), start: the code and its QR, the session's state (waiting, claimed on which device, done), End |
| Host admin: **Settings → Agreements → Desk tablets** | Admins (a person) | Enrol a tablet (its name, the enrolment code), each device with who enrolled it, when it was last seen, its browser and network flags and lock-outs, Revoke |
| Web, tablet width: **`/desk`** | The member at the desk (no sign-in) | Enter code; the due documents in turn (the Agree block's web skin); "All done: please hand the device back" |
| Host admin: **Person page → Minor** | Staff with `people:link` | Mark or clear "a minor: a parent or guardian agrees for them" |

The blocks are base-layer blocks with a headless entry (`agreements` hooks), web and native skins.
No block decides anything: the block lint passes, and every refusal comes from the host.

## Out of scope

- Legal wording of any kind, and any template document.
- An outside signing service; witness signatures; a kiosk account on a shared device (signing at
  the desk is in: decision 22).
- More than one language per document.
- Scans of paper forms kept in the host.
- Withdrawing an agreement (a person who no longer agrees cancels; health answers can be updated).
- A waiver per named attendee for several tickets on one order.
- A child's age from a date of birth.
- Submitting evidence to the provider in a dispute (issue #245 decides what a dispute does; staff
  download the PDF for now).
- Agreements for staff or practitioners themselves (contracts with them).

## Acceptance criteria

1. **No way round** (the core suite, over `invoke` and over HTTP, with a waiver and terms attached to
   `membership` and the waiver and a health form to `booking`): with any of them due, each of these is
   refused with `agreements_due`, and allowed once the acceptances exist:
   - a signed-in customer starting a membership subscription (with and without a continuation offer),
     buying a pass, and making a first booking (booked and waiting), and taking a free place from the
     waitlist themselves;
   - a guardian booking for a dependant who has no guardian's or paper acceptance;
   - staff (a person) starting a subscription, an order or a booking for a Person, through the admin,
     `record.create`, `my.create`-style paths and the pack's tools;
   - a visitor's drop-in (`x.bookings.buy`) and a guest's pass or subscription without the
     acceptances in the call; with them, the order starts and they are recorded with it;
   - the assistant and an MCP client acting for an admin, by any operation, naming ids directly.
   The host's own moves (promotion, a paid drop-in booked, timed moves) are not refused.
2. **The race**: a document published with "agree again" (or attached) between `agreementsDue`'s read
   and the commit fails the booking's, the order's and the subscription's batch (`conflict`), and a
   retry is refused with the new version due. Proved by holding a batch open across a publish.
3. **"Agree again" is not retroactive**: after it takes effect, existing bookings stay booked, a
   waiter is still promoted, a running subscription is still charged and renewed, and the next
   booking and the next purchase ask for the new version. A small change asks nobody.
4. **An acceptance cannot be changed**: every column but `person_id` (null to a Person, or merged to
   survivor) and the identity columns (to null only) is refused by the database for every writer,
   host code included; no operation updates or deletes one; a version is refused any update or
   delete (step 1: proved with raw SQL as well as through every operation).
5. **Publishing is a person's** (step 1):
   - **Who is refused**: `agreement.publish`, `attach`, `detach` and `retire` are refused, not
     queued (no pending action exists afterwards), to the assistant, MCP and Code Mode, automations
     and extension code, with every grant. A person without `agreements:manage` is refused; a
     granted member publishes.
   - **Drafting**: the assistant can make a draft and write the working copy for a person who
     holds it. Under a cautious policy that write waits for approval, and its dry run changes
     nothing.
   - **What a publish must match**: the hash and rev of the preview the person saw. It is refused
     when any field changed since (who, for whom, how, ask again after included), or when the copy
     was saved again. Two saves of one rev never both apply.
   - **What the database refuses**, by raw SQL as well: an `INSERT OR REPLACE` over a version, a
     document or the counter; a forged version; a current version set back or cleared; a state set
     back; a kind changed. A version whose hash does not match its content reads as not intact.
   - **Content**: pictures, link text other than its address, bidi controls and zero-width-only text
     are refused.
   - **Retiring and attaching**: retiring cancels a scheduled version, which never takes effect. A
     document not yet in force is not attached.
   - **The counter**: every publish, attach, detach, retire and scheduled version taking effect
     bumps `core_agreement_rev` once.
   - **Audit and reach**: each act is audited. No `core_agreement_*` table is reachable by
     `query.sql`, a dashboard, an export, search or a `rec_*` view.
   - **The editor**: its confirm shows the exact snapshot. A change by an AI after the person opens
     it is refused with a clear message, and the page says who changed the copy.
6. **Guests**: a guest's acceptances carry the version, hash, typed name and the order's address; they
   become the matched Person's in the verified payment's batch, or at `order.setPerson`; an order
   that expires unpaid deletes them; the answer to a guest is the same whatever the address matches.
7. **Children and paper**: a guardian's acceptance needs a live link at commit (the link ended a
   moment before fails the batch); a dependant's own acceptance, and a Person marked minor's own, is
   refused and never counts, signed in or at the desk; marking and clearing a minor is a person's act
   with `people:link`; a paper acceptance names the staff user, when they recorded it and the date on
   the form, is shown as "recorded from paper" on every screen and the PDF, and is a person's act
   only.
8. **Health answers are isolated**: the coach's class list carries "health note" (a yes or no per
   Person) and nothing else of the form; with a fixture of answers, no staff bulk path (record lists,
   search, `query.sql`, dashboards, exports, summaries, embeddings, the digest, the Trash list, the
   timeline, audit values, notification email bodies), no AI actor and no practitioner reads any of
   them; staff with `agreements:health` read them on screen, a person only, and each read is audited;
   errors carry no values.
9. **Signatures**: strokes are checked (empty, a dot, too many points, too large refused); never in an
   AI's reads, errors or audit values; drawn identically on the web, in the app and in the PDF.
10. **The copy and the PDF**: each acceptance by a person sends one copy to its address through the
    host's mail (applied without review under the default floor), with `agreement.pdf` built by the
    gatekeeper from checked values; no other attachment is accepted; the downloaded PDF and the
    attached one are the same bytes for the same input; health answers are not in the email.
11. **Moved members**: an imported Person with a continuation offer can sign in and read their records,
    cannot take the offer or book until they agree, and can afterwards.
12. **Cooling off**: with the setting at 14, a new member's `subscription.coolOff` on day 13 ends the
    subscription and owes a full refund of each paid period, each waiting for a person with
    `orders:refund`; on day 15, or with a continuation offer, or with the setting at 0, it is refused.
13. **Ticketing and Courses** sell exactly as before with nothing attached; with a waiver attached to
    `event`, a ticket's guest checkout needs it.
14. **Erase and merge**: erase deletes health answers and unpaid guest acceptances at once and keeps the
    rest detached for the retention period, after which the purge deletes it; merge re-points
    acceptances and changes nothing in them.
15. **Signing at the desk** (the core suite, over `invoke` and over the desk origin):
    - **Who may act**:
      - `agreement.desk.enrol` and `revoke` are refused to everyone but an admin who is a person,
        whatever is granted, and every admin is told of an enrolment.
      - `start` and `end` are refused to every AI actor and to staff without `agreements:desk`. A
        pack-role account (a coach) granted `agreements:desk` may start one.
      - Start is refused for a Person in the Trash, a marked minor for themselves, a signer with no
        address, a dependant whose link is not live, and a revoked device.
    - **The device**:
      - `desk.claim` is refused without an enrolled, unrevoked device credential, whatever the
        code. A claim from a phone that saw the code is refused.
      - The device credential alone reads nothing.
      - Enrolment and each claim record the browser and the network address, and a change is
        flagged.
      - A claim rotates the credential, and a retry within 60 seconds with the old credential and
        the code gets the same answer.
      - The old credential presented later revokes the device and tells the admins.
      - A claim by a device other than the one staff chose, or a failed claim on it, ends the
        session and tells staff. The staff screen shows the claiming device.
      - Revoking ends the device's open session at once.
    - **Origin, codes and cookies**:
      - The desk is served only on its own origin, and the staff origin serves no desk page.
      - A code claims once, expires unclaimed after 2 minutes, is stored only as an HMAC under a
        server-side secret, and wrong codes lock the device out.
      - Both cookies are `HttpOnly`, `Secure` and `SameSite=Strict` and appear in no URL.
      - A desk write without the desk origin's `Origin` is refused.
    - **Isolation**:
      - A session's token, with its own device's credential, reads only its Person's (and listed
        dependants') due documents.
      - A version of a document not due for them, another Person's `forPersonId`, and any record,
        booking, membership, answer or address are refused or absent.
      - The same token with another device's credential is refused.
      - A staff cookie is neither needed nor accepted in its place.
      - The token reaches no operation but the five desk calls.
    - **Limits from server-side state**:
      - The 3-minute idle limit, the 20-minute limit and "a new claim ends the old one" are enforced
        by the host from the session row. A call after either limit is refused and ends the
        session, whatever the page does.
      - Heartbeats keep a reading member's session alive, but not faster than every 20 seconds and
        never past 20 minutes.
    - **The record**:
      - An acceptance made there is `channel: "desk"` with its session, which names the staff user,
        the device and the times.
      - It is shown as "agreed at the desk on the device enrolled as [name] by [admin] on [date]",
        never as "in person" and never as paper.
      - A parent's acceptance for a child needs a live link at commit.
    - **The copy and its marks**:
      - The copy goes every time to the verified sign-in address, or to the record's. Its words say
        what it proves and no more.
      - It also goes to the previous address when the address changed in the 30 days before.
      - Addresses are compared by mailbox.
      - An address changed by any path in the 30 days before or after, a Person created that day,
        and a staff account's own address each show as a mark on the acceptance, not an alert.
16. `pnpm lint typecheck test`, `cos ext check` and `cos ext test` on the packs that declare points,
    the block lint, and one e2e test per journey (staff publish a document, then a changed version as
    "agree again" (step 1); a member agrees on first sign-in and books; a visitor agrees and pays for a
    class; a parent agrees for a child; staff publish "agree again" and the member is asked at their
    next booking; staff record a paper form; a member signs at the desk on a tablet-width page) pass
    in CI. ADRs for each platform piece; `CONTEXT.md` and `docs/architecture.md` updated.

## Dependencies

- Stages 25, 31a (steps 3 to 8, merged) and 32 (32a, 32b steps 5 to 7, merged).
- PR #256 (31a step 9, the calendar file and the email gatekeeper's changes, ADRs 0570 to 0574):
  **merged**, so step 4 here waits for nothing.
- Nothing from 31b, 32b step 8, 33 or 43, and nothing from `feat/routine-mail`. Stage 43's step 4
  waits for steps 1 and 2 here (above).

## Migrations and numbers

Block **AX** in [`parallel-work.md`](../parallel-work.md): migrations 0850–0869, ADRs 0640–0649.
Step 1 used migration 0850 (`core_agreement_document`, `core_agreement_version` with its no-update,
no-delete and draft triggers, `core_agreement_point`, `core_agreement_rev`) and the permission
`agreements:manage`. Later steps: `core_agreement_acceptance` (its update trigger),
`core_agreement_signature`, `core_agreement_answer`, `core_agreement_copy`,
`core_agreement_minor`, `core_agreement_desk_device`, `core_agreement_desk_session`;
`core_write_guard` made again with the kind
`agreements` (as migrations 0610 and 0670 did); the permissions `agreements:paper`,
`agreements:health`, `agreements:desk`; the retention setting. No `x_*` table is touched. ADRs:

1. Agreements: documents, versions, publishing by a person only, effective dates, "agree again"
   (**ADR 0640**, step 1).
2. The `agreements` behaviour: points and attaching documents (**ADR 0641**, step 1);
   `agreementsDue` and its guard (step 2 amends it).
3. Acceptances: the paths, the immutable record, signatures as strokes, the minor mark.
4. Health answers and their isolation.
5. The copy and the signed PDF: host mail for agreements, and the gatekeeper's second attachment
   (amending ADR 0571).
6. Cooling off.
7. Keeping acceptances after erase (**ADR 0646**, step 8).
8. Signing at the desk: a session a person starts, a tablet with no sign-in.

ADRs 0428 (a guest's acceptances settle with the order), 0435 (`sellable` and points), 0491 (a
continuation needs the terms), 0503 (the engine's create checks), 0540 (a guardian agrees for a
dependant), 0560 (`order.startHeld` carries acceptances) and stage 43's consent ADR are amended
with dated notes.

## Suggested build order

| Step | What | Platform files it touches | Runs beside stage 31, 32 and 43 work? |
| --- | --- | --- | --- |
| 1 | **Documents and versions** (**built**, `feat/stage-44-documents`): tables, the working copy, `agreement.publish` (human only, against the reviewed working copy's hash), scheduling by the minute cron, attach, detach, retire, `core_agreement_rev` (bumped by each), the permission `agreements:manage`; the `agreements` declaration in the SDK and contract (inert); the admin's document list and editor | migration 0850; `packages/core/src/agreements/` (new); `operations/agreement.ts` (new); `packages/sdk` (`agreements.ts`, the declaration and contract checks); the runner's minute tick; the admin settings routes; the registry | Done |
| 2 | **Acceptances and the one question**: `agreementsDue` and the guard kind (reading step 1's counter); `me.agreements.*`, `recordPaper`, the guardian path, the minor mark (`agreement.setMinor`); signatures; health answers and their isolation (audit redaction, no views), the coach's "health note"; the Person tab, the acceptances and due lists | `agreements/`; a migration remaking `core_write_guard`; `visibility/` (read only: `guardians.ts`'s live link and guard); audit redaction; `open-operations.json`; the admin Person page | **Yes, now** (step 1 is built). The `core_write_guard` remake **collides with any build adding a guard kind** at the same time: agree the order of the two migrations in `parallel-work.md` |
| 3 | **Enforcement** (**built**, `feat/stage-44-enforcement`, ADR 0644): `createOrder` and `order.startHeld` (guest acceptances in the batch, settlement in the verified payment's batch and `order.setPerson`, deletion on expiry); `startSubscription`; the transition engine's create and move checks; the points on Memberships and Bookings, then Ticketing and Courses | `orders/orders.ts`, `orders/events.ts`, `orders/guests.ts`, `subscriptions/subscriptions.ts`, `records/states.ts` (create checks), `packs/memberships`, `packs/bookings` (index and `buy`), `packs/ticketing`, `packs/courses` | **Not beside other work in `orders/` or the engine's create checks** (31a step 10, 31b, 32b step 8 if it touches `startSubscription`). Its own window; reviewed as stage 25 was |
| 4 | **The copy and the PDF**: the PDF writer module (vendored or our own, noted in `UPSTREAMS.md` if vendored), the gatekeeper's `agreement` part, `callAsHost` purpose `agreements` with the copy's idempotency key, the download routes, the blank PDF | `packages/gatekeeper-email-send` (`validate.ts`, `worker.ts`, a new `agreement.ts`), the fake outbox, `integrations/runtime.ts` (the purpose), `apps/app/src/server/http/` (downloads) | Yes, after step 2 (PR #256 is merged); beside anything but other email-gatekeeper work (issue #259, and `feat/routine-mail` while it is open) |
| 5 | **Blocks and hooks**: Agree, Before you go on, My agreements, a child's, the checkout and booking steps; the web signature pad (pointer events) and the native one | base-layer blocks, a headless `agreements` entry in `packages/client`, the client template's routes, the Bookings and Memberships web blocks (the inline step) | Yes, once step 2's operations are merged; coordinate with whoever owns the drop-in and timetable blocks |
| 6 | **Signing at the desk** (decision 22): `core_agreement_desk_device` (admin enrolment announced to every admin, browser and network recorded, rotation idempotent for 60 seconds, a clone revokes) and `core_agreement_desk_session` (bound to the device staff chose, idle and total limits and the bounded heartbeat held on the server); `agreement.desk.enrol` and `revoke` (admins, a person) and `start` and `end` (`agreements:desk`, made grantable to fixed-role accounts, ADR 0600 amended); `desk.claim`, `desk.documents`, `desk.accept`, `desk.heartbeat`, `desk.finish` (public, needing the device credential and the session token); the desk origin (its own hostname, set up by `cos deploy`), its cookies (`HttpOnly`, `Secure`, `SameSite=Strict`), the `Origin` check; HMAC of codes and tokens under an env secret; the lock-out; the staff side's Sign at the desk (with the claiming device) and Desk tablets; the address marks on the Acceptances list, by mailbox, over every path that changes an address; the copy's wording; the desk page at tablet width from the Agree block's web skin. No native work | `agreements/` (a new `desk.ts`), `operations/agreement-desk.ts`, `open-operations.json`, `principals.ts` (the fixed-role grantable list), `apps/app/src/server/identity.ts` and the Worker's routing (the desk origin), `packages/release` and `cos deploy` (the hostname), a new desk route, the admin Person page | After step 2 (it records acceptances) and step 4 (every desk acceptance sends its copy); its page after step 5's Agree block. Beside anything but other work on public paths in `identity.ts` |
| 7 | **Cooling off**: the setting, `subscription.coolOff`, refunds owed per period | `subscriptions/` (a new `cooling-off.ts`), `orders/refund-due.ts`, `packs/memberships` (the setting, the member's button) | Yes, beside 31 work; **not beside other `subscriptions/` work** (issue #254's hardening) |
| 8 | **Erase, merge, the Trash and retention** (**built**, `feat/stage-44-erase`, ADR 0646): erase keeps acceptances detached, deletes answers, the minor mark and open desk sessions; merge re-points; the purge after the retention period (copy rows with it); a copy that was waiting for a person: its pending approval cancelled, and the email gatekeeper's storage scrubbed of an erased person's copies (the sent history's recipient and subject, and the journal records with the whole message; left here by step 4's reviews) | `records/erase.ts`, `records/erase-stores.ts`, `person.merge`, `purge.ts` | **Not beside other erase or merge work** (the "erase completeness" reserved area, stage 43 step 4) |
| 9 | **Stage 43's consent** as a `care` acceptance (when stage 43 step 4 is built) | `agreements/`, stage 43's `care.ts` | With stage 43 step 4 |
| 10 | **The first client**: the business writes and publishes its four documents, attaches them; a moved member's first sign-in in test mode; a visitor's drop-in; a parent for a child; a member at the desk | The first client's own repository and deployment | After 3 to 6; before members pay or train on the new system |

**The spine is steps 1 to 3.** Step 1 is built; step 2 can start now. Step 3 is the riskiest (every
way to pay or book) and gets the most careful review. Step 4 waits for step 2 only.

## Decided by this spec, open to override

- **Agreements are core tables, not records**, and are in no `rec_*` view.
- **Packs declare points; the business attaches documents.** Nothing is needed anywhere by default.
- **An AI cannot ask to publish a document** (stricter than ADR 0480 for records).
- **The host's own moves are never checked** (promotion, a paid drop-in booked, timed moves), so
  "agree again" is never retroactive.
- **A drawn signature is kept as strokes**, at most 32 KB.
- **The PDF is built on demand by a TypeScript PDF writer**, in the gatekeeper for the email and in
  the host for downloads; never stored.
- **The copy is host mail**, applied without review like an order's confirmation.
- **A guest's acceptances are deleted when their order expires unpaid.**
- **Staff cannot agree for anyone**; they send a link, start a desk session or record paper.
- **The health form asks again after 12 months** by default (a guess).
- **One language per document.**
- **How, who and for whom are in the working copy**, so they change only when a person publishes;
  a document's kind is fixed when it is made (step 1).
- **A published version is never withdrawn**, even scheduled; a newer one replaces its wording
  (step 1).
- **The desk tablet holds no sign-in**; a staff member's own session starts each desk session.
- **A minor is a mark staff set**, never an age the host works out.

## Questions for the owner (answered 2026-11-23)

The owner's answers are decisions 15 to 22 above. Each question is kept as it was asked, with its
answer.

1. **When a person asks to be erased, what happens to their signed agreements?**
   - (a) Health answers are deleted at once; the rest of each acceptance (what, when, how, the name,
     the signature) is kept, detached from the person, for a set number of years (default 7), then
     deleted.
   - (b) The acceptance is kept but the name, address and signature are removed at once: only "a
     person accepted version 3 at this time" remains.
   - (c) Everything is deleted at once.
   **Recommended: (a).** The record is the business's evidence for a claim or a dispute that can come
   years later; (b) keeps nothing that proves who. The number of years is for the lawyer.
   **Answer: (a)** (decision 15).

2. **Cooling off: a member who cancels inside the period after using the gym gets what back?**
   - (a) A full refund, whatever they used.
   - (b) A refund less a drop-in price for each class they attended.
   **Recommended: (a).** It is what "full refund" means to a member, the period is short, and it is
   simple to explain. (b) needs a price per visit and the law may not allow it.
   **Answer: (a)** (decision 16).

3. **Cooling off: who does it cover?**
   - (a) New members' memberships only: not passes, not members moving over with a continuation offer.
   - (b) Memberships and passes.
   - (c) Everyone, members moving over included.
   **Recommended: (a)**, and one setting for every plan. A moved member is not a new contract in the
   member's eyes; a pass is bought and used at once. Confirm with the lawyer.
   **Answer: (a)** (decision 17).

4. **Should a coach see a mark on the class list when a member answered yes to a health question?**
   - (a) Yes, a mark only; the answers only to staff with the health permission.
   - (b) No: the Person page only.
   **Recommended: (a).** The coach on the floor is who needs to know to ask. It adds one read to the
   coach role.
   **Answer: (a)** (decision 18).

5. **When a member answers yes to a health question, can they book straight away?**
   - (a) Yes; staff with the health permission are told to look.
   - (b) No: they wait until a person on the staff marks the form as reviewed.
   **Recommended: (a).** (b) blocks a first booking on staff being quick, and the business decides
   with its insurer what a "yes" needs (a doctor's clearance is a business process, not the app's).
   **Answer: (a)** (decision 19).

6. **A child with their own account (a teenager): who agrees for them?**
   - (a) Only a linked guardian, or paper.
   - (b) The child themselves for the waiver and the health form; a guardian for the guardian consent.
   **Recommended: (a).** The host does not know a child's age, and a minor's own agreement is
   doubtful evidence.
   **Answer: (a)** (decision 20), with the minor mark.

7. **Should the emailed copy of the health form include the answers?**
   - (a) No: the questions, and "your answers are in the app".
   - (b) Yes, the whole form.
   **Recommended: (a).** Email is the least protected place health information could go.
   **Answer: (a)** (decision 21).

8. **Should a new member be able to agree at the desk, on a staff tablet?**
   - (a) Not in this stage: they agree on their own phone (staff send a link or show a code), or on
     paper.
   - (b) Yes: a desk mode where the member types or draws on the staff device, recorded as theirs and
     witnessed by the staff account.
   **Recommended: (a).** On a staff device anyone could type the name; paper is at least a real
   signature. (b) can follow if the desk needs it.
   **Answer: (b)**, changed from the recommendation (decision 22): designed in [Signing at the desk](#signing-at-the-desk-decision-22), with the session started by a person on the staff and a tablet that holds no sign-in.

## For the business to confirm with its insurer or lawyer

The platform takes no view on these. Each has a default in this spec.

1. The wording of all four documents, including what the terms say about billing, cancelling,
   pausing, price changes and cooling off.
2. Whether a ticked box with a typed name is enough for each document, or a drawn signature is needed
   (the waiver and the guardian consent above all).
3. Which consumer rules in the business's state apply to a gym membership: a written agreement, a
   copy given within a time, a cooling-off period, its length, and the refund due after use.
4. How long to keep signed agreements and health forms (for a child, perhaps until they come of age
   and then a period), and whether an erase request may be refused for them.
5. Whether the health questions should follow a standard pre-exercise screening tool, what a "yes"
   requires (a doctor's clearance), and how often to ask again.
6. Which changes to a document need everyone to agree again (a price change, a new rule), and with how
   much notice.
7. Whether members moving over must agree before their first charge on the new system, when their
   card and membership are moved rather than started again.
8. Whether a parent's consent must name the relationship, and whether one parent is enough.
9. Whether paper forms from the current system should be kept, and for how long.
10. What the card provider and the bank expect as evidence in a dispute, and whether the time, the
    account, the copy sent and the PDF are enough without the device and internet address
    (decision 3).
11. Whether keeping health information with a provider whose storage may be overseas is covered by
    the business's privacy policy (stage 43's location hint applies to new installs only).
12. Whether an acceptance made at the desk (the member's typed name or drawn signature on the
    business's enrolled tablet, in a session a named staff member started, with the copy emailed to
    the member) is enough evidence for each document, and whether the business wants a second staff
    member present. Note plainly: the emailed copy is the deterrent against staff signing for a
    member; it is not proof that the member was there.
13. When a person marked as a minor should be treated as an adult (the host never works out an age:
    staff clear the mark).

## Sources

Read 2026-11-23, all in this repository: `AGENTS.md`, `CONTEXT.md`, `docs/architecture.md`,
`docs/roadmap.md`, stages 31, 32 and 43; ADRs 0428, 0429, 0435, 0456, 0480, 0491, 0507, 0512, 0513,
0540, 0552, 0560, and 0571 and 0572 on PR #256's branch; issues #245 and #259;
`packages/core/src/orders/checkout.ts`, `orders.ts` (`createOrder`), `once.ts`,
`subscriptions/subscriptions.ts` (`startSubscription`), `records/person-approves.ts`,
`records/publish.ts` (the header), `integrations/runtime.ts` (`callAsHost`),
`packages/db/migrations/0650_person_links.sql` and `0670_unmoved_guard.sql`,
`packs/bookings/index.ts` (the booking's declarations). The owner's routine-email decision of
2026-11-23 is as the coordinator reported it; it is not in the repository yet.

Not confirmed, and checked at build: the size a vendored PDF writer adds to the email gatekeeper's
bundle; how standard PDF fonts handle every character a business types (a publish should refuse what
the PDF cannot draw); that the native app's touch handling draws a signature smoothly without a new
module; and how a membership ended at once treats bookings ahead (stage 32b's behaviour, which
cooling off follows).

## Step 2: build notes (`feat/stage-44-acceptances`, 2026-11-23)

Built: migration 0851 (`core_agreement_acceptance`, `core_agreement_signature`,
`core_agreement_answer`, `core_agreement_minor`, and `core_write_guard` made again with the kind
`agreements`, every earlier kind carried forward), ADRs 0642 (acceptances, who may agree for whom,
signatures, the minor mark) and 0643 (health answers), ADR 0641 amended (`agreementsDue` and its
guard), ADRs 0540, 0449 and 0436 amended with dated notes. The permissions `agreements:paper` and
`agreements:health` (admins by default, grantable). `agreements/due.ts` (`agreementsDue`,
`requireNothingDue`, `agreementsGuard`), `agreements/accept.ts` (every acceptance),
`agreements/capture.ts` (typed name, strokes, answers), `agreements/people.ts` (erase, purge and
merge), `operations/agreement-acceptance.ts`. The Person page's Agreements tab; Settings →
Agreements → Acceptances (the due list and the acceptances); the editor's "asks N people" on
agree again and each version's count; "Health note" on Bookings' class list (web and native).

Operations (every one with its audience, actors, permission and risk class):

| Operation | Audience | Actors | Permission | Risk |
| --- | --- | --- | --- | --- |
| `me.agreements.due` | customer (hostInternal) | the customer | records:read | read |
| `me.agreements.list` | customer (hostInternal) | the customer | records:read | read |
| `me.agreements.get` | customer (hostInternal) | the customer | records:read | read |
| `me.agreements.accept` | customer (hostInternal) | the customer | records:write | write |
| `agreement.person` | staff | every actor (no mark, no capability for an AI) | records:read | read |
| `agreement.acceptances` | staff | every actor | records:read | read |
| `agreement.due.list` | staff | every actor | records:read | read |
| `agreement.healthNotes` | staff | human | agreements:health | read, every read audited |
| `agreement.listHealthNotes` | staff | extension, inside a tool a person called themselves, for a declared list | records:read | read, every call audited |
| `agreement.healthReviews` | staff | human | agreements:health | read, every read audited |
| `agreement.acceptance.get` | staff | human | records:read | read |
| `agreement.answers.get` | staff | human | agreements:health | read, every read audited |
| `agreement.recordPaper` | staff | human | agreements:paper | write |
| `agreement.setMinor` | staff | human | people:link | write |

Deviations from the text above, and why:

- **`agreement.recordPaper` has no `forPersonId`.** `personId` is whom the form is for (for a
  child, the child), and `signedBy` names who signed it. A second id would have made two people
  for one paper row with no rule for which counts. It also takes `typedName`, the name as written
  on the form, which the record's `typed_name` holds (the spec's input list omitted it).
- **The notice of a health "yes" names nobody.** Its title is "A member's health form needs a
  look" and it links to the Person, because an in-app notice may also go out by email or Slack;
  the spec's in-host wording "[name] answered yes" would have carried a name and a health fact
  into those.
- **`agreement.healthNotes` is a new core read** (the spec said the coach role "gains that one
  read"): a pack's tool asks the host, which gives the mark only inside a tool a person called.
  Bookings declares it; `roster` and `classList` carry `healthNote` (null when the host gives
  none, as for the assistant).
- **A new pipeline option, `auditReads`**, writes an audit row for every successful read of an
  operation that sets it (a person's reads are otherwise not audited, ADR 0090). Only
  `agreement.answers.get` uses it.
- **`me.agreements.due` asks every point**, not one: the first sign-in's "before you go on" shows
  everything attached anywhere for the caller and each live dependant.
- **The due list's people** are those with a sign-in, a subscription as holder, a live family
  link as a dependant, or the minor mark (2,000 at most), those with a live subscription first.
  "Members with a booking ahead first" needs pack knowledge the core does not have; step 3, which
  declares Bookings' point, can add it.
- **The channel** is `app` for a native app's device session and `web` otherwise, from the
  session, never from the input.
- **Erase, the Trash purge and merge** were touched as far as these tables need to be safe:
  erase and the purge delete health answers and the minor mark and keep acceptances detached
  (`erased_at`); merge moves acceptances (and those made as a guardian) to the survivor and keeps
  the mark. Left for step 8: the retention purge after `keepAcceptancesYears`, the setting, the
  erase screen's words, finding a kept acceptance by name or address, the merge preview's count.
- **`context` must be null** until step 9 (the care consent) remakes the insert trigger.
- **Not built here** (later steps, as the build order says): enforcement at checkout,
  subscription start and booking (step 3; `requireNothingDue` is ready for it), the copy, its
  `core_agreement_copy` row and the PDF (step 4: the acceptance already stores the address), the
  Agree, Before you go on and My agreements blocks (step 5), "send a link", the desk (step 6),
  cooling off (step 7). No practitioner principal exists yet (stage 43); when it does it holds no
  `agreements:health`.

What step 3 needs from here: call `requireNothingDue(db, { point, participant, payer, now })`
before planning the batch (it refuses with `rule: "agreements_due"` and the documents) and put the
guard it returns in the batch; for a guest, insert `by: "guest"` rows with the order (the table
and its triggers already allow a Person-less guest row, its settlement and its deletion) through
an `accept.ts` path for guests; the guard's conflict is `rule: "agreements_changed"`.

### Step 2: after the security review of PR #274 (2026-11-23)

Fixed in the same PR (ADRs 0642 and 0643 amended): the health notice names no Person and sends
staff to Settings → Agreements → Health forms (`agreement.healthReviews`); `agreement.healthNotes`
needs `agreements:health` and is audited, and pack code asks `agreement.listHealthNotes` for its
own list, only when a person called the tool themselves (not an approval of an AI's call), never
from a runtime extension; the counter moves on a minor mark, a family link, the Trash, a merge and
an erase; a detach needs the Person gone and never enables a delete; a guest's row needs a real
order and attaches only to its Person; a merge that moves agreements is a person's with
`agreements:manage`; a minor never agrees as a guardian; a document attached nowhere is refused
and a repeat of the same version records nothing; paper counts from its date for "ask again"; one
rule for what applies (a payer document never for a child).

**Decision (coordinator, 2026-11-23, owner to confirm): erasing a guardian.** Erasing a person
treats the acceptances they made as a guardian as their own: the record that a guardian agreed,
the version and the time stay for the retention period; the guardian's typed name and drawn
signature are cleared, the address stays (as decision 15 keeps it), `erased_at` is set so step 8's
purge covers the row, and it no longer counts for the child. Migration 0851 was edited in place
(it was not on `main`).

### Step 2: after the second review of PR #274 (2026-11-23)

Fixed in the same PR (ADRs 0642 and 0643 amended): health notices are for the person only
(`human_only`: no AI actor lists, counts or marks them); `audit.list` shows no audited-read row to
an AI; `me.agreements.get` shows a guardian's typed name and signature only to that guardian; the
health-note list is declared in the manifest (`healthNotes: { list, person }`), its `value` must
be a live record of the list's object, every call is audited, and a coach's today-only limit holds
on it; a minor mark is never rewritten and a Person is never inserted over one. Migration 0851
was edited in place again.

## Step 3: build notes (`feat/stage-44-enforcement`, 2026-11-23)

Built: `agreements/enforce.ts` (`enforcePurchase`, `enforceEntry`, the guest acceptances' schema),
`guestDue` and `agreementsDueAt` in `agreements/due.ts`, a guest's path through `accept.ts`;
migration 0853 (settlement and deletion of a guest's acceptances, by trigger); ADR 0644; ADRs 0428,
0435, 0491, 0503, 0540, 0560, 0641 and 0642 amended with dated notes. The points on Memberships
(`memberships.plan`, `memberships.passtype`, `memberships.pass`), Bookings (`bookings.booking`),
Ticketing (`ticketing.tickettype`) and Courses (`courses.course`, `courses.bundle`,
`courses.plan`); the packs' buying tools pass a guest's `agreements` on.

Every path that makes an order, a subscription, a booking or a ticket, and whether it asks:

| Path | Asks? | Why |
| --- | --- | --- |
| `order.start` (customer, guest, staff, the assistant, MCP; `x.memberships.buy`, `x.ticketing.orderStart`, `x.courses.buy`) | Yes, `createOrder` | Every order is priced there |
| `order.startHeld` (`x.bookings.buy`: a member, a guardian for a child, a visitor) | Yes, `createOrder`, at the booking's point, for the booking's Person and the payer | The drop-in is made `held` by the host, so the engine does not ask it again |
| `subscription.start` (customer, guest, staff naming a holder) | Yes, before the provider's page is opened or an open one handed out again | Every subscription starts there |
| A continuation offer (`subscription.start` with `offerId`) | Yes | It is a start (decision 8) |
| `record.create`, `record.update`, `my.create`, `my.update`, the record import, a bulk update, automations, extension code | Yes, the engine | Every caller's write runs `applyTransition` |
| `x.bookings.book`, `bookFor`, `move` (a new booking), joining a waitlist, a waiter taking a free place | Yes, the engine | Each makes a booking booked or waiting |
| `x.memberships.givePass` (a pass by hand) | Yes, the engine (`memberships.pass` declares `membership` with `enter: ["active"]`) | Starting a pass, as buying one (decision 6) |
| `order.honourLate` | Yes, for the order's Person | Keeping the payment makes the purchase; a guest's acceptances went at expiry |
| A coach unticking (attended to booked), a no-show ticked | No | Between two states that hold the place: the same booking |
| Promotion from a waitlist, a paid drop-in booked, timed moves, a series' records | No | The host's own moves: "agree again" is not retroactive |
| What a paid line or a subscription grants (a pass, a ticket, an enrolment, a membership), renewals and period orders | No | The host's, after a purchase that was asked |
| `order.checkout` of an order already started, a part-paid balance, cancelling, leaving a waitlist | No | Nothing new is bought or booked |
| A plan change or a pause of a running subscription | No | An existing membership (open to review) |
| `x.courses.enrol` (staff give access), the courses import | No | Courses' points are on what is sold; giving access is not buying; imported students are moving over |
| A ticket made by hand | No | Tickets are what a paid line grants |

Deviations from the text above, and why:

- **`memberships.pass` declares the `membership` point too** (`enter: ["active"]`): the spec names
  only the plan and the pass type, but a pass staff give by hand (`givePass`) is a record made by a
  caller, not an order, and would otherwise start a pass with nothing agreed. A granted pass is the
  host's and is not asked.
- **The engine's rule for a move** is "into a listed state from any other, except between two
  states that both hold the place" (an object with `claims`): the spec named the cases (a booking
  made, a waiter taking a free place); a coach unticking a name must not ask (not retroactive).
- **A change of a record's Person while it is in a listed state asks** (staff giving a booking to
  someone else): it is that Person's booking from then.
- **A staff move to another class asks**: it makes a new booking (`movedFrom`).
- **Settlement and deletion are triggers** (migration 0853), not host code in the payment and
  expiry paths, so they hold for every writer whatever the batch's order.
- **A subscription checkout never confirmed** has no expiry the host sees: its guest acceptances
  are deleted by the minute cron's `agreement.takeEffect` three days on.
- **A pack tool's refusal** reaches its caller as the tool's error (`extension_error`) with the
  host's `agreements_due` and documents inside; the Bookings tools' refusal reasons are unchanged
  (the inline step is step 5's).
- **`agreements` is redacted from every extension tool's audit**, not only the core operations'.
- **Not built here**: the reconciler naming an attached document whose point an upgrade would drop
  ("A point that goes away", above: the attachment is kept and simply asked by no object until it
  is re-attached; the plan, the review's words and the "point no longer declared" mark are left for
  the reconciler's own change); "members with a booking ahead first" on the due list; the blocks
  that show what is due before "Pay" and "Book" (step 5). No e2e journey is in this step: each
  journey of criterion 16 needs step 5's screens.

### Step 3: after the review of PR #280 (2026-11-23)

Fixed in the same PR (ADR 0644 amended): a minor who would pay where the payer must agree is
refused (`minor_payer`; a parent or guardian buys it). **Coordinator decisions, owner to
confirm:** a guest's acceptance counts only for its own purchase, never at a later point; a
guest's purchase with a minor's address stands, the child stays due for a guardian, and staff
with `agreements:manage` are told. `order.setPerson` takes only a Person with the order's
address, and a minor only once nothing is due. Left as a follow-up (an issue): staff-given
enrolments and hand-made tickets are not asked while `givePass` is.

## Step 4: build notes (`feat/stage-44-copy`, 2026-11-23)

Built: migration 0854 (`core_agreement_copy` and its triggers), ADR 0645; ADRs 0571, 0642 and
0643 amended with dated notes. `agreements/copy.ts` (what the PDF says for each viewer, the copy's
message, `sendAgreementCopies`), `operations/agreement-copy.ts`, the email gatekeeper's
`agreement.ts` (the rule) and `agreement-pdf.ts` (the writer), its `validate.ts` and `worker.ts`,
`callAsHost`'s purpose `agreements` in cos-runner's integration host and queue, the fake outbox,
the minute cron's "agreement copies" step, and the download routes
(`apps/app/src/server/http/agreement-pdf.ts`, mounted in `server.ts` and the client-app binding).

Operations:

| Operation | Audience | Actors | Permission | Risk |
| --- | --- | --- | --- | --- |
| `me.agreements.pdf` | customer (hostInternal) | the customer | records:read | read |
| `agreement.acceptance.pdf` | staff | human | records:read (answers only with agreements:health; a kept or unsettled one with agreements:manage) | read, every download audited |
| `agreement.version.pdf` | staff | human | records:read | read |
| `agreement.copy.preview` | staff | human | agreements:paper | read |
| `agreement.copy.send` | staff | human | agreements:paper | write |

`agreement.acceptance.get` also says whether the copy went (`copy`).

Every path, and its copy:

| Path | Copy |
| --- | --- |
| A customer for themselves (`me.agreements.accept`) | At once after the commit, to their sign-in address |
| A guardian for a child | At once, to the guardian's sign-in address; the PDF names the guardian and shows their name typed and strokes only to them |
| A guest with their purchase | When it settles to the purchase's Person (the verified payment, `order.setPerson`, a confirmed subscription), by the minute cron, to the address it was bought with; none if the order closes unpaid |
| Paper | Only when a person with `agreements:paper` presses "Email a copy": shown the address first (`agreement.copy.preview`), and confirming it (`confirmTo`, refused if it is not the host's address now), to the Person's sign-in address or primary email; refused when there is none, and for a child's form (staff give the guardian the PDF) |
| The desk (step 6) | Made by the same trigger (`self` or `guardian` with an address); step 6 adds the previous address and its words |

Deviations and decisions, and why:

- **A PDF writer of our own**, not a vendored library: about 800 lines with no imports, the
  standard fonts only, every text a hex string. A library would have added hundreds of KiB and
  font embedding and parsing this needs none of; nothing is added to `UPSTREAMS.md`. It is its
  own package (`@composable-os/agreement-pdf`, no dependencies), imported by the email gatekeeper
  and the download route; core asks only its page estimate at publish (never fewer pages than the
  writer draws), so cos-runner carries no writer: its main module is 7,578 KiB after merging
  `main` at fb452202 (budget 7,680).
- **The gatekeeper's `agreement` part has no field for answers** (only `answers: "in-app"`), where
  the spec allowed answers "only where the host asked": the copy never asks, and a part that
  cannot hold them cannot leak them.
- **The approval card names no one**: "Signed agreement: [title], version [n], agreed by the
  person / by a parent or guardian / by a buyer without an account, [UTC time]". The spec's
  "[who]" would have put a name where an AI acting for an approver can read it.
- **The copy's text names no one either** and has no link: it says what was agreed, when, how,
  and that it is under My agreements in the app or on the website. A guardian's copy says the
  attached file names whom it is for.
- **Who sees a name typed and strokes in a download** follows `me.agreements.get`: only whoever
  agreed. The copy is built as the recipient's own download is, so for anything but a health form
  the attachment and the person's download are the same bytes; a health form's download adds the
  answers. A paper form's signer and note are in staff's file only; its name on the form is in a
  person's download only for an adult's own form (for a minor's the host cannot tell which parent
  signed). A guest's copy names the buyer as typed, never the Person matched to the address.
- **Downloads are operations that return what the PDF says**; the route draws it. Two prefixes, as
  the media route: `/api/agreements/…`
  (staff, behind Access) and `/api/v1/agreements/…` (a customer on the host's hostname or over the
  client-app binding; staff by session too).
- **A paper form's copy goes to the Person it is for, an adult**, and is refused when they have
  none. For a child (a marked minor or a live dependant) it is refused for now (coordinator's
  decision after the review of PR #283, the owner being asked): staff give the guardian the PDF
  download. `paperCopyRecipient` is the one place that decides it.
- **The copy is not routine mail** (ADR 0590): that is a pack automation's mail held per run, not a
  general host template path, so the copy uses `callAsHost` as the spec first said.
- **A deployment with no email channel** keeps copies queued until one is set, reads none of them
  meanwhile, and tells admins once.
- **When a copy waits for a person:** under today's gate, never in practice: the host's own message
  applies at once unless the deploy-time floor denies it (then `failed`). `waiting` covers a send
  the host could not see decided (a submission cut off before it was applied, which email-send
  submits again on the retry) and any later rule that holds host mail: a waiting copy is asked
  about again (15 minutes, doubling, at most a day) until it is `sent` or turned down (`failed`).
- **Idempotency keys are kept apart by who is sending** (the review of PR #283, ADR 0645 as
  amended): per class of queue (not per kind, the second review: a retry may be decided another
  kind), each class pruned by its own volume, the copy's keys refused to every other queue, keys
  remembered before still read on a miss for one release; `listSent()` shows the host's
  agreements, sign-in and orders mail only to that same queue; and callers' waiting sends (500)
  never block the host's copies and sign-in codes (their own 100). A copy refused for a full queue
  waits, uncounted, and admins are told once. What went wrong is kept as a category, never the
  provider's words.
- **The minute cron's copy step pauses with the automation kill switch**, as every minute step.

Not built here: the "Email a copy" button and the download links on screen (steps 5 and the admin
Person tab), the desk's copy wording and previous address (step 6), the retention purge of copy
rows (step 8). Left for step 8 by the reviews of PR #283: on erase, cancelling a person's pending
approval of a copy that was waiting, and scrubbing the email gatekeeper's storage. Until then it
keeps, for an erased person: the sent history's recipient and subject for each of its last 200
sends (`listSent`, shown only to the same class of queue); and every pending, failed or
not-yet-forgotten journal record of their copies, with the whole message (the address, the
record lines, the name typed and the strokes). Erase already clears the copy row's address, its
error category and its pending approval's id, and cancels any copy not yet sent.

 Not verified: the PDF in Email Service itself (it is passed as bytes, which the
binding's types allow) and in mail clients; the copy through the real email-send gatekeeper and
the real integration host together (each is tested with the other's double: the runner with the
fake outbox, the gatekeeper with a fake queue).

## Step 8: build notes (`feat/stage-44-erase`, 2026-11-23)

Built: migration 0855 (`core_agreement_hold`; the acceptance's update trigger made again with one
more erasure, a buyer's paid purchase nobody settled; the delete triggers of the acceptance, its
signature and answers made again to allow the purge; `core_agreement_copy`'s `scrub_due_at` and
`scrubbed_at`, its erase and update triggers made again and a delete trigger), ADR 0646; ADRs 0320,
0642 and 0645 amended with dated notes. `agreements/people.ts` (erase, merge counts),
`agreements/retention.ts` (the setting, the purge's selection, `runAgreementRetention`),
`agreements/copy.ts` (`scrubErasedCopies`, and the sender marking a scrub owed when its claim was
taken by an erase), `operations/agreement-retention.ts`; email-send's `scrubAgreementCopy`; the
integration host's `callAsHost` allows it for purpose `agreements`; the fake outbox does the same;
the daily maintenance runs the purge; Settings → Agreements → Kept after erase; the merge preview's
agreement lines.

Operations:

| Operation | Audience | Actors | Permission | Risk |
| --- | --- | --- | --- | --- |
| `agreement.retention` | staff | every actor | records:read | read |
| `agreement.setRetention` | staff | human | policy:manage | destructive |
| `agreement.kept.find` | staff | human | agreements:manage | read, every search audited (input redacted) |
| `agreement.kept.hold` | staff | human | agreements:manage | write |
| `agreement.purgeKept` | staff | automation, system origin only (`hostStep`) | records:erase | write |
| `agreement.mergePlan` | staff | every actor (says `person` to an AI) | records:read | read |

`person.erase` returns `agreementsKept { count, until, deleted }`. `agreement.acceptance.get` now
refuses a kept acceptance (or a buyer's not yet settled) without `agreements:manage`, and reads a
Person's through the visibility seam, as `agreement.acceptance.pdf` does.

What erase does to each store, and where it is tested (`packages/core/test/agreement-erase.test.ts`,
`packages/gatekeeper-email-send/test/scrub.test.ts`):

| Store | On erase |
| --- | --- |
| Their acceptances | Kept detached: Person and account cleared, `erased_at` set; version, time, how, name typed, address and signature kept |
| Acceptances they made as a guardian | Kept on the child's record without the guardian, account, name typed or strokes; address kept; the child is due again |
| A buyer's acceptances with their address or Person: unpaid order, unconfirmed checkout | Deleted with signature and answers |
| A buyer's acceptances on a paid order nobody settled | Kept detached (the order's address is cleared, so it can never settle) |
| Health answers | Deleted (a child's on a guardian's acceptance stay with it until the purge) |
| The minor mark | Deleted |
| "A health form needs a look" notices of their acceptances | Deleted |
| `core_agreement_copy` | Address, error and pending action cleared; not sent if not gone; scrub owed if it ever reached the gatekeeper |
| The host's pending approval of a waiting copy | Turned down; input, reason, preview and simulation redacted |
| Email-send's journal records of their copies | Dropped; a later send under the key refused |
| Email-send's history lines of their copies | Recipients and subject blanked (`[erased]`) |
| Audit, approvals and orders mentioning the addresses their acceptances hold | Redacted by erase's terms (the addresses are added to them) |
| Their PDFs | Downloadable only by staff with `agreements:manage` (the person has none: their sign-in is gone) |

Deviations and decisions, and why:

- **A legal hold** (`agreement.kept.hold`) is new: the coordinator asked that the purge never take
  what a hold keeps, and no hold existed. It holds who and when, no reason (free text would be
  personal data of its own); the audit says who held what.
- **The retention setting is an admin's** (`policy:manage`, as `audit.setRetention`), not a pack
  setting with `personApproves`: it is core's, and shortening it deletes evidence. 1 to 50 years;
  an unreadable value purges nothing.
- **A buyer's acceptance on a paid order nobody settled** (an address several People share, staff
  not yet having said whose) is kept detached when an erase clears the order's address: the spec
  named only unpaid ones. It is evidence of a purchase that can no longer settle to anyone.
- **An unconfirmed subscription checkout's** buyer acceptances are deleted like an unpaid order's.
- **The health notice** of an erased person's acceptance is deleted: it names nobody, but beside a
  kept acceptance it would say that this person answered yes.
- **The addresses an erased person's acceptances hold** join erase's terms and addresses (an
  earlier sign-in address, a purchase's address), so the audit, approvals and orders are redacted
  for them too.
- **A copy whose send was in flight when the erase landed** reads `cancelled` though it was
  delivered; the gatekeeper's record of it is scrubbed after. The person got their own copy before
  they were erased.
- **The scrub is asked right after the erase and by the minute cron's copy step**, not before the
  erase commits: a gatekeeper that cannot be reached must not block an erasure, and the copy row
  keeps the scrub owed (the database clears it only with `scrubbed_at`) until it is done.
- **The open desk session** (decision 22) has no table yet: step 6 must end a Person's open session
  on erase and keep a closed one detached with the acceptances it made.

cos-runner's main module is 5,619 KiB as shipped after merging `main` at 42fe315b (budget 7,168).

A Person purged from the Trash owes the same scrub of their copies (the same trigger). Not built
here: a download link on the kept page (no screen downloads a PDF yet, as
step 4 said). Not verified: the scrub against the real email-send and integration host together
(each is tested with the other's double), and the purge against D1 at a scale of thousands of kept
acceptances (it is bounded to 100 per round, ten rounds a day, index-ordered).

### Step 8: after the privacy review of PR #288 (2026-11-23)

Fixed in the same PR (ADR 0646 amended; migration 0855 edited in place, as it was not on `main`):

1. **Erasing a child reached the guardian** (a blocker this step introduced): the addresses erase
   took from agreements included the guardian's on their acceptance for the child. Now only the
   erased Person's own (`self`, and `guardian` as the agent); more than 50 is refused.
2. **The scrub goes to the gatekeeper the copy reached** (`via` on the copy row), not the current
   channel; a gone one is `unreachable`, admins are told once; after 30 days owed the purge goes
   ahead and audits it. The gatekeeper answers `found` apart from `done`.
3. **Paper free text** is `agreements:manage`'s only, and a guardian's erase clears it on their
   dependants' paper forms (coordinator decision, owner to confirm).
4. **`agreement.acceptance.get` is audited** (the id and whether kept); `kept.find` records the ids
   it showed.
5. **Open purchases close on erase**: unpaid orders cancelled by the host; unconfirmed
   subscription checkouts closed (`core_subscription_checkout.erased_at`, address cleared), so a
   later confirmation makes nothing.
6. **The retention setting is read one way** in host and database.
7. A runner test for the integration host's `scrubAgreementCopy`; an e2e journey for Kept after
   erase (find, open, hold, release); `agreement.erasePreview` on the Erase requests list (the app
   has no erase button of its own); a typed confirmation of how many records a shorter period makes
   due; no silent caps in erase's reads.
