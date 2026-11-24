# ADR 0670: Routine messages: text and push on the routine mail path, a row per channel, host kinds

Status: accepted, 2026-11-24 (stage 30, build step 1: `feat/stage-30-routine-messages`, block BB:
migration 0910). Builds on and amends ADR [0590](0590-routine-mail.md) (routine mail, with its five
amendments). Builds on ADRs [0402](0402-staff-and-customers.md) (audiences),
[0429](0429-payments-gatekeeper-verified-events-and-refunds.md) (the host's own message) and
[0540](0540-the-family-link.md) (guardians). Quiet hours are ADR
[0676](0676-quiet-hours-and-urgent-messages.md). The stage's decisions 2, 4, 5, 9 and 11
(`docs/stages/30-notifications.md`).

## Context
A business must reach its members on the channel that suits each message: email, a text, or a
push on its own app. ADR 0590's routine mail already decides who a record's message goes to, fills
the declaration's words with values a person stands behind, holds anything an AI wrote, caps and
logs each send, and lets a human admin turn each kind off; its guarantees took five security
reviews. A second path for texts and pushes would need all of it again. Stage 30 grows routine
mail into **routine messages** instead, and adds kinds the host declares itself (a membership
payment that failed, issue #215), which host code asks for rather than an automation.

## Decision

**A kind may also go by text and push.** A `routineMail` kind (the manifest key, the table
`core_routine_mail` and the `routineMail.*` operations keep their names) gains:

- `channels`: `["email"]` by default; `text` and `push` need their words in every message, and
  words need their channel. Every kind goes by email.
- Per message, `textMessage` (one line) and `push` (`{ title, body }`), with the same slots, and a
  guardian's version of each (a guardian is texted or pushed only in words declared for a guardian).
- `essential` (default true for `account`, false for `follow_up`): whether a person may turn its
  email off (decision 9; their choices are step 5's). `purpose`: `account` or `follow_up`, never
  `news_and_offers`; an essential follow-up is refused.
- `urgent` and `until` (a date or datetime path of the record: a class's start), for quiet hours
  (ADR 0676). An urgent kind names its moment.
- `open: { screen }`: the app screen a push opens with the record's id, never a web address. A
  native block declares the screens it is (`screens` in its `block.json`); the repository's test
  (`packages/product/test/routine-screens.test.ts`) holds every pack's kinds to their own blocks'
  screens, because `cos ext check` sees the manifest, not the blocks.
- A field slot may be `private` (health, pay, a note, a door code): never in push words.

**The contract check** (`routineMailIssues`, `packages/sdk/src/routine-mail.ts`) refuses text and
push words that use an undeclared slot, a list (`each`), or a slot that may be empty outside an
optional part; push words with a link slot or a private slot; words with a link, an address or a
second line; and words that could not fit with **every slot at its longest**: a text, with the
business's name the host puts first (`senderName`, at most 30 characters) and "Reply STOP to
stop" it puts last,
in two segments (306 characters in the plain alphabet, 134 when the declared words themselves
force the longer encoding); a push's title in 60 characters and its body in 140. A text slot counts
at its `max` (default 120), a moment at its longest written form, a choice at its longest words, a
link at 120, the member's name at 80. So a pack that wants a class's title in a push declares a
shorter slot for it (Bookings' `short`, at most 40): a longer title holds only the message that
shows it. A runtime extension still may not declare any of it (`outsideDeclarations`).

**A row per recipient and channel.** Preparing a send writes, per recipient, the email row exactly
as before and then, when the kind is on, its pack's routine messages turned on, and a human admin
switched that channel on for the kind (`channels` in the `routine_mail` setting, off by default):
a push row and then a text row, for a recipient who is a Person (the record's, or a guardian).
An order's own address is not a Person's phone or app: those kinds stay email only. Each row:

- is held for exactly the reasons the email would be, for what **its own words** show: the
  record, its link to its Person and its state, and the slots its words name (a class title an AI
  changed holds the email, the text and the push alike). A value's problem (a title too long for
  the shorter slot, a link in a name) now holds only the messages whose words show that slot, as
  its marks already did (ADR 0590's third review); the email's held reasons are otherwise
  unchanged;
- asks how the Person is reached (`ChannelReach`, `packages/core/src/routine-mail/reach.ts`): a
  textable number (ADR 0673, step 3) or a registered app device (ADR 0674, step 4). Until those
  steps are built nobody is reachable, and the row is kept `no_channel` with the reason, its email
  sent as before. Push is asked first; with "text only without the app" on (the default, decision
  2) a member a push reached is not also texted (`no_channel`, "reached by push");
- is `failed` when its words, filled, do not fit (a value forcing the longer encoding; a long
  link) or the routine settings lack what it needs (`quietZone`; for a text, `senderName`),
  `expired` when the kind's moment has passed, `held` when it is held for a person (never `ready`
  or `waiting`, the states a sender and the clock act on), `waiting` with `wait_until` during
  quiet hours, else `ready`;
- keeps the number or device only while it waits to go, and its words only until it is decided,
  as an email's words; the log keeps kind, channel, status and cost, and a key for the caps.

New states, in the database's check (migration 0910): `held`, `delivered`, `stopped`, `expired`,
`over_limit` and `no_channel` beside ADR 0590's. Idempotency keys gain the channel and the Person
for texts and pushes; an email's key is unchanged.

**Sending.** The email path is ADR 0590's, unchanged: `claimRoutineMail` claims email rows only.
A ready text or push is its gatekeeper's to send (steps 3 and 4: the text gatekeeper's and the push
gatekeeper's glue in the integration host, through the host's `routine-mail` queue); nothing sends
one in this step. The runner's minute cron releases what quiet hours held (ADR 0676).

**Host kinds.** The host declares kinds of its own in core code (`declareHostRoutineKind`,
`packages/core/src/routine-mail/host-kinds.ts`), with the same declaration and the same contract
checks, ids `core.<name>` (`core` is an id no extension can take, so no pack's kind shares one).
Host code asks with `sendHostRoutineMessage` (`host-send.ts`) naming a kind, a record and an
**occasion** (a provider event, a failure's first date): the same occasion sends nothing twice, a
new one sends again. There is no operation and no host module: the assistant, MCP, a tool and an
automation have nothing to call. Everything after the caller is a pack's path: the recipient from
the record, the declaration's words, every value checked by its mark (`prepareHostRoutineMail`).
The run's checks (a manual trigger, a replay, an AI's change starting it) do not apply, host code
being the cause; what an AI wrote still holds it. Its email goes through the org email connection
Settings → Notification delivery names (as the host's order confirmation, ADR 0429) via the
integration runtime's `sendRoutineMessage`, the integration host's `sendRoutineMail` with the same
routine queue and the `email.routine` kind; a held one waits for a person in the host's own change
set for the kind. With no email channel set the row is kept, failed, with the reason. A host kind
is off until a human admin turns it on, whatever its declaration says; there is no pack switch.
In this step host kinds may be about orders (the host's own columns); step 2 adds subscriptions'.

**Settings** (`routine_mail`, a human admin's only, `routineMail.settings.update`): per kind the
text and push switched on, within what it declares; `textOnlyWithoutApp` (default on); quiet hours
(ADR 0676). `routineMail.get` shows each kind's channels, whether it is essential, its purpose,
whether it is urgent and whether it is the host's; `routineMail.log` shows each row's channel and
status and filters by channel.

## The packs
- **Bookings**: confirmations, waiting list news, class changes, cancellations and reminders gain
  text and push words, for the member and for a guardian, opening the timetable screen
  (`bookings-native-timetable` declares `timetable`); pointless once the class has started
  (`until: class.startsAt`). Reminders and waiting list news are optional; the rest essential.
  Cancellations are urgent. Drop-in payments and refunds are about the order: email only.
- **Ticketing**: the reminder the day before gains text and push words, optional, opening the
  ticket's screen (`ticketing-native-ticket` declares `ticket`), until the event starts. The
  tickets and the balance reminder go to an order's own address: email only. A ticket's door code
  is a private slot.

## Why
- One path keeps one set of guarantees: the AI hold, the marks, the caps, the switches and the log
  are ADR 0590's on every channel.
- Default off, twice: a channel is off until a human admin switches it on, and nothing reaches a
  phone until the text and push gatekeepers and the consent register (steps 3 to 5) are in.
- The length checks are at declaration time, so a pack's words never silently cost a third segment
  or run off a locked screen; the host's own check at send time catches what values can still do.

## Consequences
- An admin who switches a kind's text or push on today sees a `no_channel` row per recipient in the
  log, with why, until steps 3 and 4 land; members get exactly the emails they got before.
- A value too long for a text's or push's shorter slot no longer holds the email (it never showed
  it); before, any slot's problem held every email of the send.
- Host code can send a business's own message to a record's person on the routine path; the first
  users are subscriptions' payment messages (step 2, ADR 0671).

## Proof

| Check | Test |
| --- | --- |
| Text and push words: undeclared slots, two segments at the longest, the longer encoding, push bounds, private slots, links and lists in a push, two lines, an essential follow-up, words without their channel, a push without a screen, `until` not a time | `packages/sdk/test/routine-mail.test.ts` ("text and push words") |
| A runtime extension declaring any of it | `packages/core/test/routine-mail.test.ts` ("who may declare it", unchanged) |
| ADR 0590's tests pass unchanged | `apps/runner/test/routine-mail*.test.ts`, `bookings-messages.test.ts`, `bookings-held.test.ts`, `ticketing.test.ts`; `packages/core/test/routine-mail*.test.ts` |
| A row per channel; `no_channel` while nobody is reachable, the email sent | `apps/runner/test/routine-messages.test.ts` |
| With the app a push and no text; a textable mobile a text; neither, email only | `apps/runner/test/routine-messages.test.ts` |
| A class title an AI changed holds the email, the text and the push | `apps/runner/test/routine-messages.test.ts` |
| A host kind: checked as a pack's, off until turned on, no automation, the same occasion once, failed with no email channel, sent through the real gatekeeper | `packages/core/test/routine-messages.test.ts`, `apps/runner/test/routine-messages.test.ts` |
| The channel switches a human admin's only, only channels a kind declares | `packages/core/test/routine-messages.test.ts` |
| A push opens a screen its pack's native blocks declare | `packages/product/test/routine-screens.test.ts` |
| One message for one recipient on every channel: a bounded number of statements | `apps/runner/test/routine-messages.test.ts` ("the cost") |

## Amended 2026-11-24, after the review of PR #339

Built before merge, each with a test that fails without it:

- **The name a text begins with is a human admin's** (`senderName` in `routine_mail`, at most 30
  characters, checked by `unroutineText`), never the organisation's general name, which
  `settings.update` lets the assistant or an MCP client change at once under Balanced. No text is
  switched on until it is set. The zone quiet hours are read in is likewise `quietZone` (ADR 0676).
- **A held text or push is `held`**, never `ready`; the end of quiet hours decides each row again
  (the kind, the pack, the channel, routine) before it is `ready`.
- **A choice's words count in a text's encoding**: one that forces the longer encoding is held to
  134 characters at the check, as declared words are.
- **Private is the field's**: a second slot reading a field another slot marks private is private
  in push words too.
- **A guardian is texted or pushed only in a guardian's words**: a message with no guardian's
  version goes to a guardian by email only. No shipped pack has such a message, so this is not
  reproduced by a test on the shipped packs.
- **A host kind's occasion** is keyed on who it goes to (the rule and the Person), not the
  address: an order whose address changes is not sent the same occasion twice. A host kind's email
  kept `failed` for want of an email channel goes when its occasion is asked again once one is set.
- `routineMail.get`'s weekly counts are emails only.

Proof, added: `packages/sdk/test/routine-mail.test.ts` (a choice's encoding, private by field);
`packages/core/test/routine-messages.test.ts` (the release's re-checks and batches, the skipped
hour, the zone and the name a human's, the host kind's retry and key);
`apps/runner/test/routine-messages.test.ts` (an MCP client's rename and time zone reach no text; a
held text and push are `held`).

