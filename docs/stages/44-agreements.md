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
and ADR 0571 (a calendar file made by the email gatekeeper, in PR #256); stages
[31](31-bookings.md) (drop-ins, the family link), [32](32-memberships.md) and
[43](43-practitioners.md) (the care link's consent); issue
[#245](https://github.com/timoconnellaus/composable-os/issues/245) (disputes);
`packages/core/src/orders/` (`orders.ts`, `once.ts`, `guests.ts`, `events.ts`, `refund-due.ts`),
`packages/core/src/subscriptions/subscriptions.ts`, `packages/core/src/records/person-approves.ts`,
`records/publish.ts`, `records/states.ts`, `visibility/guardians.ts`, the migrations 0650 (the
family link's guard) and 0670 (`core_write_guard`), and `packs/bookings/index.ts` (the booking's
declarations).

Status: **spec proposed** (owner interviewed 2026-11-23; the questions at the end are still open).
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

- **Nothing records an agreement.** No table holds a document, a version a person accepted, a
  signature or health answers. Roadmap stage 29 (Forms, not specced) listed "waivers with a
  signature"; this stage takes waivers from it.
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
  builds from checked values (ADR 0571, PR #256).
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

## The design in one page

**Agreements is a core capability with its own tables, not records.** A **document** has drafts and
**versions**. A version, once published, is never changed or deleted while anyone accepted it. Only a
person with `agreements:manage` publishes, and an AI cannot even ask.

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
(typed name, drawn signature, paper) and when. The database refuses any change to what it says. A
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

### Documents and versions

- **`core_agreement_document`**: id (`agd_…`), title, kind, **how** a person agrees (`typed`: tick
  and type their name; `drawn`: type their name and draw a signature), **who agrees** (`participant`:
  the person who trains or attends; `payer`: the person who pays), **for whom** (`everyone`, or
  `dependants`: only a Person who is a dependant of a live family link), for a `health` document
  **ask again after** (months; empty for never), the points it is attached to, state (`draft`: never
  published; `live`; `retired`: no longer needed anywhere, its acceptances kept), the working copy
  (below), the current version, and `agree_from`: the version from which acceptances count.
- **The working copy** is the draft the editor changes: the title, the body (rich text, ADR 0440's
  schema), the **tick label** (the words beside the box; the business writes them, and a document
  without them cannot be published), and for `health` the questions. Staff with `agreements:manage`
  edit it; the assistant may write it for them (an ordinary write through the gate). Editing it
  changes no version.
- **`core_agreement_version`**: id (`agv_…`), document, number (1, 2, 3), title, body, tick label,
  questions, how, **change** (`first`, `small`, `agree_again`), **effective from** (an instant),
  published at and by (a staff user, a person), and **hash**: SHA-256 of the canonical JSON of what a
  person is shown (title, body, tick label, questions). The database refuses any update and any
  delete of a version (a trigger), and acceptances reference it.
- **Publishing**: `agreement.publish { documentId, change: "small" | "agree_again", effectiveFrom? }`
  (staff, `agreements:manage`, **`actors: ["human"]`**: the assistant, MCP, automations and
  extensions are refused, not queued). It snapshots the working copy into a new version. A first
  version is `first`. The screen shows the change against the current version, and for "agree
  again" how many people it will ask (those with a current acceptance of the document now). An
  `effectiveFrom` in the future schedules it: the minute cron makes it current at that time. Before
  then the earlier version stays current; the new one can be read and accepted early (it counts from
  when it takes effect, and after).
- **Why an AI cannot ask to publish** (unlike ADR 0480): decision 12 says it never publishes, and an
  approval card is a poor place to read a long legal text. A person opens the editor and publishes.
- **Attaching and retiring**: `agreement.attach { documentId, points }` and `agreement.retire
  { documentId }` (staff, `agreements:manage`, `actors: ["human"]`): what is needed where is policy,
  and loosening it (detaching, retiring) is a person's act. Attaching a document makes it due at
  once for anyone without a current acceptance (it is not retroactive: nothing already bought or
  booked is touched).
- **Languages**: one language per document in this stage. A second language is a later stage.

### When an acceptance is current

An acceptance of document D counts for D while all of these hold:

1. its version's number is at least D's `agree_from` (an "agree again" version moves `agree_from` to
   itself when it takes effect; a small change does not move it);
2. for a `health` document with "ask again after" set, it was made less than that many months ago
   (decided by the host's clock);
3. it is **for** that Person, and for a Person who is a dependant, it was made by a guardian with a
   live link at the time, or recorded from paper (question 6 asks about older children);
4. its Person is not in the Trash.

A newer acceptance of the same document replaces an older one for every purpose; both are kept.

### The `agreements` behaviour: agreement points

An object declares where agreement may be needed (SDK and contract; shipped and reviewed packs, as
`sellable` is):

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
  batch of every change to what is due: a version taking effect with "agree again" or as a document's
  first, a document attached, detached or retired, a scheduled version made current by the cron. If
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

- **A guest's acceptances become the Person's at settlement.** The verified payment that matches the
  order's address to a Person (ADR 0428, ADR 0560) sets the acceptances' Person in its own batch.
  Several matches: when staff settle the order (`order.setPerson`). An order that expires or is
  cancelled unpaid deletes its guest acceptances in that batch: no contract was made, and they are
  nobody's personal data to keep. A guest who is already a member and has agreed is asked again, the
  same as anyone, so the answer says nothing about who has the address.
- **Staff cannot agree for someone.** Staff starting a membership, selling a pass or booking a class
  for a Person who has something due are refused with the list, and offered two things: **send a
  link** (the host emails the Person, or their guardians for a dependant, a link to agree; a host
  mail like the copy) and **record a paper form**. Paper is shown everywhere as "Recorded from paper
  by [staff name] on [date]", never as the member's own acceptance.
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
| `email` | The address the copy goes to: the account's sign-in address, the guest's order address, or null for paper |
| `how` | `typed`, `drawn`, `paper` |
| `typed_name` | The name typed (1 to 200 characters, no control characters). For paper, the name staff read on the form |
| `channel` | `web`, `app`, `paper` |
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
  - **coaches on a class list see a mark only** (a person answered yes, with no content), if the owner
    agrees (question 4). The coach role (ADR 0436) gains that one read; issue #258 reshapes roles
    anyway;
  - **never an AI actor** (the assistant, MCP, an automation's AI step), whatever is granted. No
    setting turns it on;
  - **never a practitioner** (stage 43): a practitioner sees only their own work.
- **A "yes"**: staff with `agreements:health` are told in the host ("[name] answered yes to a health
  question"); an email or push says only "a member's health form needs a look: open the app". It
  does not block booking unless the owner decides so (question 5).
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
  floor denies it. So **it needs nothing from the routine-email work** (the owner's decision of
  2026-11-23 that a pack's fixed routine emails send without approval, not yet built). If that work
  lands first and generalises "a fixed template the host composes", Agreements uses it instead; the
  rule is the same. A guardian is sent the copy of what they agreed for their child. Paper
  acceptances send no copy unless staff press "Email a copy" (and the Person has an address).
- **Health answers are not in the email** (recommended, question 7): the PDF attached to a health
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
  whole number, 0 off (the default), `personApproves`. A plan may set its own (question 3).
- **Who may use it**: the holder's subscription to a membership plan started here by
  `subscription.start` without a continuation offer (a new member, not one moving over: question 3),
  within that many days of the provider-confirmed start (the host's clock).
- **The cancel**: `subscription.coolOff { id }` (customer, for their own as payer; staff with
  `subscriptions:manage`, a person only). It ends the subscription at once with the provider (as a
  cancel now does), and in the batch that follows the provider's verified event it writes a **refund
  owed** (`core_sellable_refund_due`) for every paid period order of that subscription, in full. The
  minute cron asks the payments gatekeeper; each refund waits for a person with `orders:refund`,
  like every refund (ADR 0429). A rejected or lapsed one tells staff, as ADR 0560's do.
- **A free trial longer than the period** leaves nothing to refund; the button says "cancel" and the
  trial ends as any trial does.
- **Uses already spent**: by default a full refund whatever was used (question 2). Bookings ahead,
  and what the ended membership gives, follow what a membership ended at once does today (stage
  32b).
- **The words** that tell a member about cooling off are the business's, in its terms. The app shows
  "You can cancel for a full refund until [date]" beside the cancel button while it applies.
- **Passes**: not covered by default (question 3).

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
  counts (question 6).
- **A guardian agrees for each child**, one acceptance each, from "My family" or when booking for the
  child: the host checks the link is live (`core_person_link_guard` in the batch). The guardian
  receives the copy. Ending the link later does not undo what they agreed; another guardian may
  agree again.
- **Staff record a paper form** for a child, naming who signed it (`signedBy`, free text: "mother,
  [name]").
- **A child with no link** is treated as an adult by the host. Staff link the parent first; the
  admin's child view says so.

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
data a person may ask to have erased. The proposal (question 1):

- **Erase** deletes at once the Person's **health answers** (all of them; the most sensitive data,
  and not evidence of the contract) and any guest acceptances on their unpaid orders. It **keeps** the
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
| Coach's class list (Bookings) | Coach | A mark beside a name with a health "yes", no content (question 4) |

The blocks are base-layer blocks with a headless entry (`agreements` hooks), web and native skins.
No block decides anything: the block lint passes, and every refusal comes from the host.

## Out of scope

- Legal wording of any kind, and any template document.
- An outside signing service; witness signatures; signing in person on a staff device (question 8).
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
   delete.
5. **Publishing is a person's**: `agreement.publish`, `attach` and `retire` are refused (not queued)
   to the assistant, MCP, automations and extensions with every grant; a person without
   `agreements:manage` is refused; the assistant can write the working copy for a person who holds it.
6. **Guests**: a guest's acceptances carry the version, hash, typed name and the order's address; they
   become the matched Person's in the verified payment's batch, or at `order.setPerson`; an order
   that expires unpaid deletes them; the answer to a guest is the same whatever the address matches.
7. **Children and paper**: a guardian's acceptance needs a live link at commit (the link ended a
   moment before fails the batch); a dependant's own acceptance does not count (unless question 6
   says otherwise); a paper acceptance names the staff user, when they recorded it and the date on the
   form, is shown as "recorded from paper" on every screen and the PDF, and is a person's act only.
8. **Health answers are isolated**: with a fixture of answers, no staff bulk path (record lists,
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
15. `pnpm lint typecheck test`, `cos ext check` and `cos ext test` on the packs that declare points,
    the block lint, and one e2e test per journey (a member agrees on first sign-in and books; a
    visitor agrees and pays for a class; a parent agrees for a child; staff publish "agree again" and
    the member is asked at their next booking; staff record a paper form) pass in CI. ADRs for each
    platform piece; `CONTEXT.md` and `docs/architecture.md` updated.

## Dependencies

- Stages 25, 31a (steps 3 to 8, merged) and 32 (32a, 32b steps 5 to 7, merged).
- PR #256 (31a step 9, the calendar file and the email gatekeeper's changes) before step 4 here.
- Nothing from 31b, 32b step 8, 33 or 43. Stage 43's step 4 waits for steps 1 and 2 here (above).

## Migrations and numbers

The next free block in [`parallel-work.md`](../parallel-work.md), claimed in the build's first
commit: `core_agreement_document`, `core_agreement_version` (with its no-update, no-delete
triggers), `core_agreement_point` (attachments), `core_agreement_rev`, `core_agreement_acceptance`
(its update trigger), `core_agreement_signature`, `core_agreement_answer`, `core_agreement_copy`;
`core_write_guard` made again with the kind `agreements` (as migrations 0610 and 0670 did); the
permissions `agreements:manage`, `agreements:paper`, `agreements:health`; the retention setting. No
`x_*` table is touched. ADRs the build will need (not written until built):

1. Agreements: documents, versions, publishing by a person only, effective dates, "agree again".
2. The `agreements` behaviour: points, attaching documents, `agreementsDue` and its guard.
3. Acceptances: the four paths, the immutable record, signatures as strokes.
4. Health answers and their isolation.
5. The copy and the signed PDF: host mail for agreements, and the gatekeeper's second attachment
   (amending ADR 0571).
6. Cooling off.
7. Keeping acceptances after erase.

ADRs 0428 (a guest's acceptances settle with the order), 0435 (`sellable` and points), 0491 (a
continuation needs the terms), 0503 (the engine's create checks), 0540 (a guardian agrees for a
dependant), 0560 (`order.startHeld` carries acceptances) and stage 43's consent ADR are amended
with dated notes.

## Suggested build order

| Step | What | Platform files it touches | Runs beside stage 31, 32 and 43 work? |
| --- | --- | --- | --- |
| 1 | **Documents and versions**: tables, the working copy, `agreement.publish` (human only), scheduling by the minute cron, attach, retire, the permissions; the `agreements` declaration in the SDK and contract (inert); the admin's document list and editor | a migration; `packages/core/src/agreements/` (new); `operations/agreement.ts` (new); `packages/sdk` (the declaration, contract checks); the admin settings route; the registry | **Yes, now.** New files, except the registry, the route tree and the SDK contract, which always conflict and are resolved by keeping both |
| 2 | **Acceptances and the one question**: `agreementsDue`, `core_agreement_rev` and the guard kind; `me.agreements.*`, `recordPaper`, the guardian path; signatures; health answers and their isolation (audit redaction, no views); the Person tab, the acceptances and due lists | `agreements/`; a migration remaking `core_write_guard`; `visibility/` (read only: `guardians.ts`'s live link and guard); audit redaction; `open-operations.json`; the admin Person page | **Yes**, after step 1. The `core_write_guard` remake **collides with any build adding a guard kind** at the same time: agree the order of the two migrations in `parallel-work.md` |
| 3 | **Enforcement**: `createOrder` and `order.startHeld` (guest acceptances in the batch, settlement in the verified payment's batch and `order.setPerson`, deletion on expiry); `startSubscription`; the transition engine's create and move checks; the points on Memberships and Bookings, then Ticketing and Courses | `orders/orders.ts`, `orders/events.ts`, `orders/guests.ts`, `subscriptions/subscriptions.ts`, `records/states.ts` (create checks), `packs/memberships`, `packs/bookings` (index and `buy`), `packs/ticketing`, `packs/courses` | **Not beside other work in `orders/` or the engine's create checks** (31a step 10, 31b, 32b step 8 if it touches `startSubscription`). Its own window; reviewed as stage 25 was |
| 4 | **The copy and the PDF**: the PDF writer module (vendored or our own, noted in `UPSTREAMS.md` if vendored), the gatekeeper's `agreement` part, `callAsHost` purpose `agreements`, the download routes, the blank PDF | `packages/gatekeeper-email-send` (`validate.ts`, `worker.ts`, a new `agreement.ts`), the fake outbox, `integrations/runtime.ts` (the purpose), `apps/app/src/server/http/` (downloads) | **After PR #256 merges** (it changes the same gatekeeper files). Then yes, beside anything but other email-gatekeeper work (issue #259) |
| 5 | **Blocks and hooks**: Agree, Before you go on, My agreements, a child's, the checkout and booking steps; native signature pad | base-layer blocks, a headless `agreements` entry in `packages/client`, the client template's routes, the Bookings and Memberships web blocks (the inline step) | Yes, once step 2's operations are merged; coordinate with whoever owns the drop-in and timetable blocks |
| 6 | **Cooling off**: the setting, `subscription.coolOff`, refunds owed per period | `subscriptions/` (a new `cooling-off.ts`), `orders/refund-due.ts`, `packs/memberships` (the setting, the member's button) | Yes, beside 31 work; **not beside other `subscriptions/` work** (issue #254's hardening) |
| 7 | **Erase, merge, the Trash and retention**: erase keeps acceptances detached, deletes answers; merge re-points; the purge after the retention period | `records/erase.ts`, `records/erase-stores.ts`, `person.merge`, `purge.ts` | **Not beside other erase or merge work** (the "erase completeness" reserved area, stage 43 step 4) |
| 8 | **Stage 43's consent** as a `care` acceptance (when stage 43 step 4 is built) | `agreements/`, stage 43's `care.ts` | With stage 43 step 4 |
| 9 | **The first client**: the business writes and publishes its four documents, attaches them; a moved member's first sign-in in test mode; a visitor's drop-in; a parent for a child | The first client's own repository and deployment | After 3 to 5; before members pay or train on the new system |

**The spine is steps 1 to 3.** Steps 1 and 2 can start today. Step 3 is the riskiest (every way to
pay or book) and gets the most careful review. Step 4 waits for PR #256 only.

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
- **Staff cannot agree for anyone**; they send a link or record paper.
- **The health form asks again after 12 months** by default (a guess).
- **One language per document.**

## Questions for the owner

1. **When a person asks to be erased, what happens to their signed agreements?**
   - (a) Health answers are deleted at once; the rest of each acceptance (what, when, how, the name,
     the signature) is kept, detached from the person, for a set number of years (default 7), then
     deleted.
   - (b) The acceptance is kept but the name, address and signature are removed at once: only "a
     person accepted version 3 at this time" remains.
   - (c) Everything is deleted at once.
   **Recommended: (a).** The record is the business's evidence for a claim or a dispute that can come
   years later; (b) keeps nothing that proves who. The number of years is for the lawyer.
2. **Cooling off: a member who cancels inside the period after using the gym gets what back?**
   - (a) A full refund, whatever they used.
   - (b) A refund less a drop-in price for each class they attended.
   **Recommended: (a).** It is what "full refund" means to a member, the period is short, and it is
   simple to explain. (b) needs a price per visit and the law may not allow it.
3. **Cooling off: who does it cover?**
   - (a) New members' memberships only: not passes, not members moving over with a continuation offer.
   - (b) Memberships and passes.
   - (c) Everyone, members moving over included.
   **Recommended: (a)**, and one setting for every plan. A moved member is not a new contract in the
   member's eyes; a pass is bought and used at once. Confirm with the lawyer.
4. **Should a coach see a mark on the class list when a member answered yes to a health question?**
   - (a) Yes, a mark only; the answers only to staff with the health permission.
   - (b) No: the Person page only.
   **Recommended: (a).** The coach on the floor is who needs to know to ask. It adds one read to the
   coach role.
5. **When a member answers yes to a health question, can they book straight away?**
   - (a) Yes; staff with the health permission are told to look.
   - (b) No: they wait until a person on the staff marks the form as reviewed.
   **Recommended: (a).** (b) blocks a first booking on staff being quick, and the business decides
   with its insurer what a "yes" needs (a doctor's clearance is a business process, not the app's).
6. **A child with their own account (a teenager): who agrees for them?**
   - (a) Only a linked guardian, or paper.
   - (b) The child themselves for the waiver and the health form; a guardian for the guardian consent.
   **Recommended: (a).** The host does not know a child's age, and a minor's own agreement is
   doubtful evidence.
7. **Should the emailed copy of the health form include the answers?**
   - (a) No: the questions, and "your answers are in the app".
   - (b) Yes, the whole form.
   **Recommended: (a).** Email is the least protected place health information could go.
8. **Should a new member be able to agree at the desk, on a staff tablet?**
   - (a) Not in this stage: they agree on their own phone (staff send a link or show a code), or on
     paper.
   - (b) Yes: a desk mode where the member types or draws on the staff device, recorded as theirs and
     witnessed by the staff account.
   **Recommended: (a).** On a staff device anyone could type the name; paper is at least a real
   signature. (b) can follow if the desk needs it.

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
