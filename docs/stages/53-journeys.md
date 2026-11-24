# Stage 53: Journeys

Read first: [`AGENTS.md`](../../AGENTS.md), [`docs/architecture.md`](../architecture.md),
[`CONTEXT.md`](../../CONTEXT.md) (Routine mail, Routine mail kind, Value mark, Automation, Run,
Outbound action, Preset, Floor, Publish, Version, Guardian, Minor, Erase, Merge, Task), ADRs
[0051](../adr/0051-outbound-approvals.md), [0130](../adr/0130-automation-runtime.md),
[0242](../adr/0242-email-sending-and-sequences.md) (proposed, not built),
[0402](../adr/0402-staff-and-customers.md), [0405](../adr/0405-skills-ship-with-the-platform.md),
[0441](../adr/0441-publishable-states-schedules-and-versions.md),
[0480](../adr/0480-an-ai-asks-to-publish-a-person-approves.md),
[0540](../adr/0540-the-family-link.md), [0573](../adr/0573-runs-over-the-rate-rail-wait-their-turn.md),
[0574](../adr/0574-an-idempotency-key-on-an-email-send.md) and
[0590](../adr/0590-routine-mail.md) with all its amendments; stages [13](13-email.md) (sequences,
proposed), [32](32-memberships.md), [31](31-bookings.md), [44](44-agreements.md) (the Minor mark),
[47](47-pack-screens.md); stage 30 (Notifications) and stage 48 (My account) as they are agreed;
`packages/sdk/src/automation.ts`, `packages/sdk/src/routine-mail.ts`,
`packages/core/src/routine-mail/`, `packages/core/src/records/transitions.ts`,
`apps/runner/src/automations/workflow.ts` and `dispatch.ts`.

Status: **spec agreed** (2026-11-24: every question the interview would have asked was decided as
best practice by the coordinator under the owner's standing rule that best-practice answers are
decided, not asked; the owner may override any of them). A new stage, 53, in the common modules.
Steps 1 to 3 may start now. The sending step (step 4) waits for stage 30's routine messages,
preferences, one-tap stop and promotional consent (below, "What this stage needs from stage 30").

Built so far:

- **Step 2, journey signals** (2026-11-24, [ADR 0802](../adr/0802-journey-signals-declared-by-shipped-packs-recorded-in-the-write.md),
  migration 1175; the spec's list below numbered this ADR 0801). `journeySignals` in the manifest
  (`packages/sdk/src/journey-signals.ts`: `JourneySignalSpec`, the check, `journeySignalFires`),
  refused for a runtime extension at check and install; `cos ext check` lists a pack's signals.
  `core_person_signal` (one row per Person and signal, with the record, the write's standing and a
  bulk flag), written by the pipeline beside the value marks in every write's batch, one statement
  however many records (`packages/core/src/journeys/signals.ts`); erase, the purge and merge
  handle it. Memberships declares `started`, `ended`, `trialEnded` and `passStarted` (the pass
  signal is an addition: "stop when they buy a pass" needs it); Bookings `booked` and `attended`;
  Ticketing `ticketBought` and `checkedIn`. Recorded in the pipeline rather than the transition
  engine and record create (the same writes, with the standing and bulk flag they lack). Nothing
  reads the rows yet: entries and the scan are steps 3 and 4.

## Goal

A business sets up messages that go out on their own to one person at a time, because of what
that person did or stopped doing: a welcome series for a new member, a nudge when someone has not
come in for two weeks, a win-back when a membership ends, a follow-up when a trial ends without a
sign-up, later a birthday message or a review request after a job. Each **journey** has an entry
rule, a few messages with waits between them, simple branches, staff tasks, and exit rules (stop
when they book or buy, unsubscribe, or staff stop it). A person on the staff approves the exact
wording once, seeing every message filled in for a sample member; after that the journey's messages
go out without anyone approving each send, while the host checks every one: preferences and
consent, quiet hours, how many messages a person has had, and that nothing an AI wrote reaches a
member unseen.

## Who it is for

**Gyms and studios first.** Their journeys are about memberships, trials, passes and visits:

- welcome series (a membership or first pass starts: day 0, day 3, day 10);
- "we have not seen you" (no class attended for 14 days while holding a live membership);
- win-back (a membership ended and nothing new was bought, after N days);
- trial ended without joining;
- birthday (on the day, in the business's zone), once a birthday is recorded;
- a pass running low or about to expire (a journey of one message).

What is specific to gyms: visits come from Bookings' attendance; children's messages go to their
parents (the family link); "stop when they buy" means a membership, a pass or a booking.

**Trades and services next.** The same engine with other entry points: a review request after a
job is finished, a quote follow-up (a quote sent and not accepted after N days), a yearly service
reminder (an anniversary entry, like a birthday), "how did we do" a week after a job. What differs:
the record is a job, not a membership; the person is often an organisation's contact; a review
request links to a page the business chose on another site. Those signals arrive with stages 35
(Invoices and quotes) and 39 (Jobs); this stage builds none of them.

## What exists today (from the code, checked 2026-11-24)

- **Automations** (`packages/sdk/src/automation.ts`, `apps/runner/src/automations/`): triggers on a
  record change, a field change, a schedule, a date relative to a field (days, or minutes up to a
  week, ADR 0570), a button, an approval decision, a webhook or a synced email; `includeBulk` opts a
  trigger into bulk writes. One Cloudflare Workflow per run with durable sleeps and
  `waitForEvent`; at most 200 advances a run (`MAX_ADVANCES`, `workflow.ts`). The only event sent to
  a waiting run is the approval decision (`reviewEventType`, `dispatch.ts`). Rails: cascade depth,
  runs per root event, runs a minute, writes an hour (ADRs 0130, 0573). Under Balanced every email
  an automation sends through `email-send` is an outbound action a person approves.
- **Routine mail** (ADR 0590, `packages/sdk/src/routine-mail.ts`, `packages/core/src/routine-mail/`,
  migration `0750_routine_mail.sql`): a shipped pack's fixed, declared emails sent without approval
  to the record's own Person and their guardians, every value checked by its **value mark**
  (`core_value_mark`, `marks.ts`) and `unroutineText`, 20 a day per address
  (`ROUTINE_DAILY_CAP`), 2,000 a day per organisation (`ROUTINE_ORG_DAILY_CAP`), a log kept
  `retentionMonths` (default 12), a switch per kind, off until a human admin turns a pack on (D1).
  The words are the pack's, shipped in code; the gatekeeper's routine shape
  (`packages/gatekeeper-email-send/src/routine.ts`) allows no reply-to and no HTML.
- **Sequences** (stage 13, ADR 0242): proposed, not built. No `core_sequence*` table exists.
- **The org email sender** (`packages/gatekeeper-email-send`) sends only: a reply to a routine
  email is not seen by the host.
- **Publishing** (ADRs 0441, 0480): working copies, versions kept for good, published by a person;
  an AI may ask, a person approves.
- **Staff notifications** (`packages/core/src/notifications/`): in-app, email and Slack to staff.
  Nothing reaches a customer by text or push.
- **Tasks** are base records (`core_task`, migration `0004_activities_tasks.sql`).
- **What a journey would listen to**: Memberships' states (`trialing`, `active`, `past_due`,
  `unpaid`, `paused`, `ended`; `packs/memberships/index.ts`), passes and their expiry, Bookings'
  booking states (`booked`, `attended`, `no_show`, and others; `packs/bookings/index.ts`), paid
  orders (`packages/core/src/orders/`), Ticketing's tickets (`packs/ticketing/index.ts`). State
  moves go through the transition engine (`packages/core/src/records/transitions.ts`).
- **No consent to be contacted and no unsubscribe exist**: no opt-out field, no unsubscribe route,
  no record of a yes to promotional messages (stage 13's `emailOptOut` was never built). Stage 30
  owns them (below).
- **No birthday**: the host holds no date of birth on purpose; a minor is a dependant of a live
  family link or a Person staff marked (the Minor mark, stage 44).

## Decided (2026-11-24)

No interview was held: each question was decided at its recommendation by the coordinator, under
the owner's standing rule. The owner may override any of them.

| # | Decision |
| --- | --- |
| 1 | **How the gym follows up today** is not asked: the draft's assumptions stand, checked with the business during setup |
| 2 | **A person approves each journey's wording once**, seeing every message and branch filled in for a sample member; after that its messages go out on their own. Any change to the wording is approved again |
| 3 | **Who approves wording**: the owner and admins, plus staff they give the right to (a manager who runs marketing need not be an admin) |
| 4 | **Only promotional journeys need a recorded yes first**; service journeys (about something the member has or did) go to every member. Every journey message carries an unsubscribe link. Which messages need a yes is for the business to confirm with its lawyer |
| 5 | **The assistant may draft wording**; a person approves it; every member gets the same approved words with their own values filled in. No per-member AI notes |
| 6 | **Birthday: day and month only**, optional, given by the member or staff |
| 7 | **Replies go to a staff email address the business names**; staff stop the journey with one click; stopping on a reply automatically comes with the shared inbox (stage 36) |
| 8 | **At most 3 journey messages a week and 1 a day per member**, across all journeys; extras wait for the next allowed day, never dropped |
| 9 | **Four ready-made journeys ship, switched off**: welcome series, "we have not seen you" (no class for two weeks), win-back after a membership ends, trial ended without joining. Birthday, pass running low and the trades review request are not seeded |
| 10 | **Parents get the journeys about their children** (service journeys, in the guardian's wording); no promotional journey is ever sent about a child |

## The design in one page

- **Journeys are a platform piece in the host, not automations and not a pack.** A journey is data
  the business edits, run by one engine in the host: a table of entries read by a minute tick and a
  daily scan, as ADR 0242 planned for sequences. Packs add only declarations.
- **Packs declare journey signals.** A shipped pack names in its manifest the moments a journey can
  start or stop on, each about a Person: "membership started", "membership ended", "trial ended",
  "class attended", "class booked". A signal is a state an object enters, or a record created, and
  the field that names its Person. The host records, in the write's own batch, the last time each
  Person had each signal (one row per Person and signal). "Not seen for 14 days" is the absence of
  "class attended" for 14 days, found by a daily indexed scan, not by pack code.
- **A journey** = an entry rule (a signal; a quiet spell after a signal; a birthday; or staff
  adding people), conditions, steps (send, wait, branch, staff task, end), exit rules (a signal
  such as "booked" or "bought", the journey preference turned off, consent withdrawn, erased, staff
  stop) and a re-entry rule.
- **Wording is published, like a page** (decision 2). The steps and messages are a working copy. A
  person with `journeys:publish` publishes a version after seeing each message rendered for a
  sample member. Only the published version sends. An AI may draft and ask to publish; a person
  decides (ADR 0480). Entries carry on with the version they started on unless the publisher moves
  them.
- **Journey messages go through stage 30's routine messages**, not a path of their own: one row per
  recipient and channel in the same log, the same per-address and organisation caps, the same
  preferences, one-tap stop, suppression list, quiet hours, delivery status and Person's Messages
  tab. A journey is a new **source** of routine message rows, beside a pack's declared kinds and
  stage 30's host kinds. Its words come from the journey's published version.
- **Sending on its own is the host's decision for each message.** It goes only if: "journeys send
  on their own" is on (a human admin's setting, off on deploy); the version was published by a
  person; every filled value has a person's or a default's value mark; the Person has not turned
  journeys off on that channel, has the consent the journey's kind needs, is under the cap and is
  outside the sending hours' quiet time; and the change that put them on the journey was not an
  AI's that no person approved. Anything else is held for a person, or skipped where a rule says
  so; nothing is silently dropped. Cautious and the deploy floor still hold every send.
- **Two kinds of journey**: *service* and *promotional* (decision 4). Promotional sends need stage
  30's recorded yes on that channel; a missing yes **skips** the send, and nobody can approve around
  it.
- **Channels**: email first; text and push once stage 30's gatekeepers exist. A step names a
  channel and what to do when the Person cannot receive it (fall back to email, or skip).
- **Replies** go to the journey's reply-to, a staff address (decision 7).

### What was weighed and rejected

| Option | Why not |
| --- | --- |
| **Journeys as automations** | One Workflow per Person per journey sleeping for weeks; "not seen in 14 days" needs a daily scan and fan-out past the runs-per-event rail; nothing can send a run "they replied"; every send is reviewed under Balanced; the wording would be code. ADR 0242 rejected the same for sequences on cost |
| **Journeys as routine mail kinds** | Routine mail's safety rests on words shipped and reviewed with the platform. A business's own whole sequence needs another guarantee: a person publishing the exact version. Journeys reuse routine messages' pipeline and checks, not its "words in code" rule |
| **A second sending path beside routine messages** | Stage 30 rejected the same: its own AI hold, caps, preferences and log, when ADR 0590's guarantees took two security reviews to get right |
| **A Journeys pack** | Recording signals in the write's batch, the send decision and the exits are host rules for every actor; a pack cannot hook writes (ADR 0405) |
| **Approving each send** | Unusable under Balanced for a gym of hundreds of members (decision 2) |
| **Approving only the first send of each version** (ADR 0242's rule) | The approver sees one member's email; publishing shows every message and branch and reuses the publish rules the platform has |
| **A visual flow builder with arbitrary logic** | Branches are a short list of declared conditions, so the host can explain each journey in plain words and test it |
| **AI-personalised messages sent unseen** | Every AI-written word sent to a member waits for a person (ADR 0590, decision 5) |
| **Journeys defining their own consent and unsubscribe** | Consent to be contacted and unsubscribe belong to Notifications (stage 30), used by Journeys, Inbox and Reviews alike; two would disagree |
| **Entering everyone who already qualifies when a journey goes live** | A new "not seen for 14 days" journey could mail hundreds on its first day. A journey enters people from the moment it goes live; the person setting it live may choose to add those who already qualify, seeing how many |

## What this stage needs from stage 30 (Notifications)

Stage 30 owns consent to be contacted and unsubscribe. This stage defines none of its own and
needs these from stage 30's agreed spec; where stage 30's draft lacks one, it is added to stage 30,
not built here:

1. **Routine messages as a pipeline with sources**: a row per recipient and channel that a journey
   step can prepare, with the same marks, caps, delivery states and log; the row carries its
   source (`journey`, the entry and the step) so the journey's log reads it.
2. **A preference kind for journeys**: one optional kind, "Automatic messages" (every journey), per
   channel, in a Person's preferences, settable by the member in My account's Messages section
   (stage 48's shell), by a parent for a child, and by staff on the member's request.
3. **The one-tap stop** (`messages.stop`) accepting a journey message's token: it turns that
   Person's journey kind off on that channel, can only turn off, and answers the same for any token.
4. **Promotional consent**: a recorded yes or no per Person and channel, with when, how (a form, at
   checkout, staff from paper or a conversation, the member) and by whom; each change a new row,
   the latest winning; given or withdrawn by the member in My account, recorded by staff (a person
   only), and offered at sign-up through Forms (stage 29) and at checkout. Merge keeps the most
   recent per channel, and a "no" on either side stays a "no"; erase removes it.
5. **The suppression list, confirmed mobiles and registered devices**, honoured for journey rows as
   for any other.
6. **Quiet hours** (business-wide, in the business's zone): journeys apply them to **every**
   channel, email included, because a journey message is never urgent (stage 30 applies them to
   texts and pushes only; this is a journey rule over stage 30's setting, not a change to it).
7. **The text limit and per-recipient text and push caps**, which journey texts count against.

## Platform work and pack work

| Piece | Kind | Notes |
| --- | --- | --- |
| `journeySignals` manifest key and its contract check | Platform (SDK, check) | Shipped packs only; a runtime extension may not declare it (as `routineMail`) |
| Recording the last time of each signal per Person, in the write's batch | **Platform, a new behaviour** | The transition engine and record create; one upsert per signal; bulk writes marked |
| Journeys, versions, steps, entries; publish; preview | **Platform, a new primitive** | `core_journey*` tables, a migration, new `packages/core/src/journeys/` |
| The engine: the minute tick, the daily scan, exits | Platform | `apps/runner` cron; no Workflow per entry |
| The send decision and the journey source of routine messages; the journey shape at the email gatekeeper (a reply-to, the host's own links) | **Platform, gate change** | Amends ADRs 0051 and 0590; after stage 30's pipeline |
| Birthday (day and month) on Person | Platform (core fields, merge, erase, the scan) | Decision 6 |
| Signals in Memberships, Bookings, Ticketing; the four starter journeys (off) | Pack work and seeds | Declarations only; no pack code sends |
| Journey screens (list, editor, publish dialog, log, settings, the Person's Journeys tab) | Platform (core admin screens) | Like Agreements' staff side; not pack screens |
| The customer side | Stage 30's Messages section in My account | No section of this stage's own (stage 48) |
| Text and push steps | Platform, after stage 30's gatekeepers | |
| Trades signals (job finished, quote sent) | Pack work, with stages 35 and 39 | |

## The model

### Words

**Journey**: a named set of steps the host takes for one Person at a time. **Journey version**: a
published snapshot of its steps and messages. **Entry**: one Person on one journey. **Signal**: a
declared moment about a Person (not "event", which Ticketing uses). **Service** and
**promotional**: the two kinds of journey. Avoid "routine" (routine mail, the assistant's
routines), "campaign" (stage 36's one-off send) and "enrolment" (Courses). Consent and preferences
are stage 30's words.

### Records (platform)

- `core_journey`: name, kind (`service` / `promotional`), status (`draft`, `live`, `paused`,
  `archived`), entry rule and conditions, re-entry rule (once ever, or not again within N days),
  `includeBulk` (default off), the reply-to (a staff address, below), owner (a staff user), the
  working copy of its steps, drafted by (person or assistant).
- `core_journey_version`: journey, number, steps as one checked document (below), published by (a
  human account), at, the plain-words summary shown at publish. Never changed (a trigger refuses
  update and delete).
- `core_journey_entry`: journey, version, Person, state (`active`, `waiting`, `held`, `finished`,
  `stopped`), current step, `next_at`, entered by (signal, scan, birthday or a person), the cause's
  standing (person, host or AI, from the root write's marks), stopped by and why. One live entry
  per Person per journey (a partial unique index); an index on (`state`, `next_at`) for the tick.
- `core_journey_step_log`: entry, step, at, what happened (sent with the routine message row's id,
  held, skipped with why, waited until, branch taken, task made). Words are never stored here; the
  message row keeps what stage 30 keeps.
- `core_person_signal`: Person, signal (`memberships.started`), last at, from a bulk write or not.
  Written by the host only; an index on (signal, last at) for the scan. In no `rec_*` view.
- `core_person` gains `birth_day` and `birth_month` (both null, or both set), with value marks like
  any field; never in a bulk export by default.

### Steps (the version's document)

- **send**: channel (`email`; `text` and `push` after stage 30), the fallback (email or skip),
  subject and body with slots from a fixed list: `{firstName}`, `{business}`, the signal record's
  title, a plan's or class type's name, `{site:<path>}` links to the business's own site, and
  `{unsubscribe}` added by the host to every message; a guardian's version for a dependant's
  service message.
- **wait**: N days or hours, optionally "until H:MM in the business's zone", "weekdays only".
- **branch**: if a declared condition holds (has a live membership, booked since entering, attended
  since entering, has promotional consent on the channel), go to step X, else step Y.
- **task**: a staff task (`core_task`) assigned to a named staff member or the journey's owner
  ("call them"), linked to the Person.
- **end**.
- A version has at most 20 steps, 8 messages and 10 branches. The check refuses a loop, a slot not
  on the list, a link that is not to the business's own site, raw addresses or phone numbers in
  words (ADR 0590's rules), and a send without the unsubscribe slot.

### Entry rules

- `signal`: when a Person gets a signal (a membership started).
- `quiet`: N days after a signal with no newer one (no `bookings.attended` for 14 days), while a
  condition holds; found by the daily scan.
- `birthday`: on the day, in the business's zone, for a Person with a birthday recorded.
- `manual`: staff add people (one, a selection or a saved view, up to 500 at a time).
- Then: the conditions, the re-entry rule, and exclusions: journeys turned off on every channel the
  journey uses, a suppressed or erased address, a promotional journey without the yes where it is
  required, and a minor (a dependant or a Person with the Minor mark) for any promotional journey.
- A signal from a bulk write (an import, a bulk change) enters nobody unless the journey has
  `includeBulk`.
- Going live enters people from that moment. The person setting it live sees how many already
  qualify and may add them (a `bulk-write`, as `journey.enter`).

### Exit rules

A signal the journey names (booked, bought a membership or a pass), the journey preference turned
off on its channel or consent withdrawn (promotional), the Person erased or trashed, merged (the
entry moves to the survivor or, if the survivor is already on it, ends), staff stop, the journey
paused (entries wait) or archived (entries stop). "Replied" is an exit rule ready for stage 36.

### The send decision (each message, at the tick)

Sent on its own only if all hold; otherwise held for a person, skipped, or waiting, as marked:

1. "Journeys send on their own" is on, the preset is not Cautious, and the floor does not review or
   deny outbound (else held; a floor's deny refuses).
2. The version was published by a human account, never the adjudicator.
3. The entry's cause was not an AI's change no person approved, and a manual entry was made by a
   person (else held).
4. Each filled value has a `person` or `default` mark for its current value and passes
   `unroutineText`; the recipient address passes ADR 0590's mark rules (else held).
5. The Person has not turned journeys off on the channel and is not suppressed; a promotional
   journey has the yes on the channel (else **skipped**: nobody may approve around a missing
   consent or a stop).
6. Under the cap: at most 3 journey messages per Person in 7 days and 1 a day across journeys
   (decision 8), and within stage 30's per-address and organisation caps (else **waits** for the
   next allowed day).
7. Outside quiet hours for the business (else **waits**).

A held send is an ordinary outbound action showing the full message; approving it marks the values
it showed as a person's (as ADR 0590) and sends; rejecting it skips that step and the entry goes on.
The routine message key `journey:<entry>:<step>:<channel>` (ADR 0574) means a retried tick sends
nothing twice.

### Children

A dependant's service message goes to their live guardians in the guardian's wording, as routine
mail does (ADR 0540); a minor is never entered in a promotional journey (decision 10).

### Operations

| Operation | Audience | Who may | Risk |
| --- | --- | --- | --- |
| `journey.list`, `journey.get`, `journey.preview` (render every message for a sample Person) | staff | `journeys:read` (admins, members) | read |
| `journey.create`, `journey.update` (working copy), `journey.archive` | staff | `journeys:manage` (admins, grantable) | write |
| `journey.publish` | staff | `journeys:publish` (admins, grantable: decision 3), `actors: ["human"]`; an AI's call becomes a publish request a person with the right approves (ADR 0480) | write |
| `journey.goLive`, `journey.pause`, `journey.resume` | staff | `journeys:manage`; an AI may pause, never go live or resume | write |
| `journey.enter` (manual, up to 500) | staff | `journeys:manage` | bulk-write |
| `journey.stop` (one entry, or all of a Person's) | staff | anyone who may update the Person | write |
| `journey.entries`, `journey.log` | staff | `journeys:read`; a Person's own entries for anyone who reads the Person | read |
| `journey.settings.update` (sending on its own, the cap, the reply-to addresses allowed) | staff | human admin, `actors: ["human"]`, not on MCP | write; loosening |
| `person.setBirthday` (day and month) | staff | `records:write` | write |
| `me.birthday.set` | customer (a reviewed change, ADR 0402) | the signed-in member, for themselves | write |

No operation sends a message: the host sends at the tick. The customer's preferences, the stop and
consent are stage 30's operations.

**The reply-to** is one of the addresses a human admin allows in the settings (staff users'
addresses, or an organisation address they confirm by a code), so a journey cannot point replies at
an outside address.

### Tools and the assistant

No pack tools. The assistant and MCP see the core operations under the usual gate: they may list,
draft a working copy, suggest a journey from a sentence, preview, ask to publish, pause a journey,
stop an entry and read the log. They may not publish, go live, resume, change settings, change a
birthday a member gave, touch consent or preferences, or send anything. `journey.enter` from an AI
is a `bulk-write`, reviewed under Balanced. A version an AI drafted shows "drafted by the assistant"
on the publish dialog. A message whose filled values an AI wrote is held. The judge's
`outbound.message` placement (stage 11) may check a version's wording at publish, as advice only.

### Screens

- **Web admin** (core screens, Settings → Journeys and a sidebar entry, like Agreements' staff
  side): the list with counts (active, finished, stopped, held); the editor (steps as a list with
  waits and branches, not a canvas), each message's preview for a chosen Person; the publish dialog
  showing every message and the plain-words summary; going live with the count of who already
  qualifies; the log; settings. A **Journeys** tab on a Person: their entries, what was sent (from
  stage 30's log, statuses only), their birthday, stop.
- **Customer web and native**: nothing of this stage's own. Turning journey messages off and
  giving or withdrawing promotional consent are in stage 30's Messages section of My account
  (stage 48); the birthday is a field in Your details. No attention kind.
- **Native staff**: the Person's journeys and stop, where the app has the Person screen.

### Notifications (to staff)

A daily digest per journey of held sends (not one per send); a journey paused by a rail; a journey
whose sends are mostly held (over 25% in a day).

### Privacy, audit and erase

- Who sees a Person's journeys and signals: staff who may read that Person (the visibility seam).
  Signals are a visit history by another name: they are in no `rec_*` view, export or dashboard.
- Every publish, setting change, going live, manual entry, stop and held-send decision is audited.
  The step log keeps no words; the message rows follow stage 30's retention (12 months by default).
- Erase deletes the Person's entries, step log, signals and birthday; their message rows,
  preferences and consent are erased by stage 30. Merge moves entries (above), keeps the later of
  each signal, and keeps the survivor's birthday unless it has none.
- How long records are kept, and what consent a message needs, are for the business to confirm
  with its lawyer. The site makes no claim of compliance.

## Out of scope

- One-off broadcasts to a list (stage 36's campaigns), which should reuse stage 30's consent and
  this stage's publish and cap.
- Receiving replies and stopping on them (stage 36's inbox; the exit rule is ready).
- Text and push steps before stage 30's gatekeepers.
- A/B tests, scores, open tracking as an exit, best time to send.
- Offers or promo codes inside a message (stage 34).
- Trades signals and a link to a review page on another site (stages 35 and 39).
- Sales sequences from a personal mailbox (stage 13): see "Decided by this spec".

## Acceptance criteria

1. Memberships declares `started`, `ended` and `trialEnded`; Bookings declares `booked` and
   `attended`; a runtime extension declaring `journeySignals` fails `cos ext check` and install.
2. A membership becoming active writes the Person's signal row in the same batch; an AI's write
   that causes it records the cause's standing as AI, and that entry's messages are held.
3. A welcome journey (three emails, day 0, 3 and 10) published by a person sends all three on its
   own under Balanced once an admin turned journeys on; with it off, each waits for approval.
4. A "not seen for 14 days" journey enters exactly the members with a live membership and no
   attended class in 14 days, from going live on, through one indexed scan; going live shows how
   many already qualify and adds them only when the person chooses; a member who books exits
   before the next message.
5. A win-back journey stops when the Person buys a membership or a pass.
6. A version an AI drafted cannot send until a person publishes it; an AI's `journey.publish`
   becomes a request only a person with `journeys:publish` may approve; the adjudicator cannot.
7. A first name an AI wrote on a Person holds that Person's message; a person's later edit of it
   lets the next one go.
8. A promotional journey skips a Person with no recorded yes on the channel, and nobody can approve
   that send.
9. Every journey email carries a working unsubscribe link (stage 30's stop): using it turns journey
   messages off on that channel and stops every journey entry that sends only on it; an invalid
   token answers the same.
10. The cap (3 a week, 1 a day) and quiet hours hold across all journeys, email included; a message
    past either waits for the next allowed time and is never dropped.
11. A dependant's service message goes to their live guardians in the guardian wording; a minor is
    never entered in a promotional journey.
12. Cautious holds every send; a floor's `review` on outbound holds, `deny` refuses.
13. A signal from a bulk write enters nobody unless the journey has `includeBulk`.
14. Erase removes entries, the step log, signals and the birthday; merge moves them by the rules
    above.
15. A retried tick sends nothing twice (key `journey:<entry>:<step>:<channel>`).
16. Cost: the tick reads due entries through the (`state`, `next_at`) index in batches; no Workflow
    per entry; the scan is one query per signal per day (statement-count tests).
17. A journey's reply-to can only be an address an admin allowed.
18. A birthday journey sends on the day in the business's zone to a Person with day and month
    recorded, and enters nobody without one.
19. The four starter journeys are seeded as drafts, never live, and send nothing until edited,
    published and set live by a person.
20. E2E, one per journey a person makes: an admin builds, previews, publishes and sets live a
    welcome journey and a member receives it; a member unsubscribes from the link.
21. `pnpm lint typecheck test` pass; ADRs, `docs/architecture.md`, `CONTEXT.md` (Journey, Journey
    version, Entry, Signal) and, once built, the site and `apps/marketing/SITE.md` are updated.

## Dependencies

- **Built:** routine mail and value marks (ADR 0590), publishing (stage 28), the family link and
  Bookings (31a), Memberships (32b), the Minor mark (stage 44), the email gatekeeper's idempotency
  (ADR 0574), Tasks.
- **Must land first for step 4:** stage 30 (Notifications): routine messages with sources,
  preferences with the journey kind, the one-tap stop, promotional consent, quiet hours (its steps
  1 and 3, and consent, above). Text and push steps wait for its gatekeepers (its steps 5 and 6).
- **Uses when built:** stage 29 (Forms) for consent at sign-up; stage 36 (replies, campaigns);
  stage 34 (offers in win-backs); stages 35 and 39 (trades signals); stage 48 (My account) for
  where stage 30's Messages section and the birthday appear.
- Issue [#259](https://github.com/timoconnellaus/composable-os/issues/259) (automations' hardening)
  does not block journeys, which use no runs, but its back-pressure lessons apply to the tick.

## Migrations and numbers

Block **BO**: migrations 1170–1189, ADRs 0800–0809 (claimed in `docs/parallel-work.md` by the
coordinator). Expected migrations: `core_person_signal` (step 2); `core_journey`,
`core_journey_version` with its trigger, `core_journey_entry`, `core_journey_step_log` (step 3);
the journey source columns on stage 30's message rows (step 4, after stage 30's migration);
`birth_day` and `birth_month` on `core_person` (step 7). New permissions: `journeys:read`,
`journeys:manage`, `journeys:publish` (grantable, a person only). No `x_*` table is touched.

ADRs the build writes:

1. **ADR 0800**: Journeys as a host primitive (journeys, versions, entries, the tick and the daily
   scan); amends ADR 0242 (sequences become journeys, once stage 13 is interviewed).
2. **ADR 0801**: Journey signals, declared by shipped packs and recorded in the write's batch.
3. **ADR 0802**: A journey publish is the approval of its wording; the send decision; journeys as a
   source of routine messages; the journey shape at the email gatekeeper (reply-to, the host's own
   links); amends ADRs 0051 and 0590 and stage 30's routine messages ADR.
4. **ADR 0803**: A birthday as day and month on Person.

## Suggested build order

| Step | What | Touches | Beside | Collides with |
| --- | --- | --- | --- | --- |
| 1 | (Stage 30's) routine messages with sources, preferences with the journey kind, the stop, promotional consent | stage 30's areas | — | Built by stage 30; this stage only checks it holds what is listed above |
| 2 | `journeySignals` in the SDK and check; recording signals in the batch; Memberships, Bookings and Ticketing declare theirs | `packages/sdk` (manifest, check), `packages/core/src/records/transitions.ts` and record create, `packs/memberships`, `packs/bookings`, `packs/ticketing` (`index.ts`), a migration | Step 3; stage 30 | Anything changing `records/transitions.ts` or those packs' `index.ts` |
| 3 | Journeys, versions, publish, preview, entries, the editor's operations, the four starter drafts | new `packages/core/src/journeys/`, operations, a migration | Step 2; stage 30; any pack work | Little (new folder); the operations registry |
| 4 | The engine and sending: the tick, the daily scan, exits, the send decision, the journey source of routine messages, the gatekeeper's journey shape | `apps/runner` (cron), `packages/core/src/routine-mail/`, `packages/core/src/integrations/outbound.ts`, `packages/core/src/gate.ts`, `packages/gatekeeper-email-send/src/routine.ts`, a migration | Steps 5 and 7; needs 2, 3 and stage 30's steps 1 and 3 | **Anything in `routine-mail/`, the gate or the email gatekeeper** (stage 30 itself, Agreements' mail work) |
| 5 | Screens: list, editor, publish dialog, going live, log, settings, the Person's Journeys tab | `apps/app` (core admin screens), `apps/app/src/components/people` | Steps 4 and 7; needs 3 | The Person page (stage 48's staff card, stage 30's Messages tab) |
| 6 | Text and push steps | stage 30's gatekeepers | — | After stage 30's steps 5 and 6 |
| 7 | Birthday: the fields, `person.setBirthday`, `me.birthday.set`, merge and erase, the entry rule | `core_person` migration, `records/` merge and erase, the scan, the Your details block (stage 48) | Steps 4 and 5 | Anything adding Person fields or merge rules; stage 48's details block |

**Up to three sessions at once**: steps 2 and 3 now, beside stage 30's build; then step 4 alone on
the gate and the gatekeeper (the one to give the most careful security review, as routine mail had
two), beside step 5 and step 7.

## Size

**Large.** A new host primitive, a new behaviour on writes, a second way for words a business
typed to leave without per-send approval, and admin screens.

## Decided by this spec, open to override

| Choice | Decision |
| --- | --- |
| Where journeys live | A host primitive, not automations and not a pack |
| How they send | Through stage 30's routine messages, as a new source; no second path |
| Consent and unsubscribe | Stage 30's; this stage lists what it needs and defines none |
| Unsubscribe | One preference, "Automatic messages", per channel, covering every journey; essential messages (a class cancelled) are untouched |
| Sending on its own | Off on deploy until a human admin turns it on once (as ADR 0590's D1) |
| A missing consent or a stop | Skips the send; never something a person can approve around |
| Quiet hours for journeys | Stage 30's business-wide quiet hours, applied to every channel, email included |
| Going live | Enters people from that moment; adding those who already qualify is a choice shown with the count |
| Bulk writes | Enter nobody unless the journey says `includeBulk` |
| Branches | A fixed list of conditions; no canvas, no code; at most 20 steps, 8 messages, 10 branches |
| Links in words | Only to the business's own site through `{site:<path>}`, and the host's unsubscribe link |
| Reply-to | An address a human admin allowed, never typed freely into a journey |
| Starter journeys | Seeded as drafts in core (not in a pack), never live |
| Screens | Core admin screens (like Agreements), not pack screens |
| Stage 13's sequences | Should become journeys with a manual entry and a personal sender, not a second engine; ADR 0242 is amended when stage 13 is interviewed |

## Questions for the owner

None open.

## Risks

- **Security:** a second exemption from approving outbound mail, with words the business typed.
  The guarantees (published by a person, marks on every value, consent, the cap, links only to the
  business's site, the reply-to allowed by an admin) need the depth of review routine mail had. The
  customer birthday write is a new customer operation (reviewed, ADR 0402).
- **Privacy:** signals record when each person last did things; readable only as the Person is,
  reached by erase. A birthday is new personal data, kept to day and month.
- **Consent and the law:** what needs a yes first, what a message must contain and how long consent
  is kept differ by country: for the business to confirm with its lawyer.
- **Deliverability:** promotional mail from the same sender as booking confirmations can harm the
  confirmations' delivery; a separate sending address for journeys may be needed. Needs a real
  provider account and real volumes to verify.
- **Mail floods:** an import or a bulk change moving hundreds to active must not start welcome
  series for all (bulk writes enter nobody by default); a new quiet journey enters nobody who
  already qualifies unless a person chooses it, seeing the count.
- **Money:** with text steps, every text costs the business; stage 30's text limit applies to them.
- **Needs real verification:** a real gym's member list (who would qualify for "not seen for 14
  days" on day one), the unsubscribe link in real mail programs, and the business's real wording.
